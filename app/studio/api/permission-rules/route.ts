import { ETAG_HEADER, apiError, apiSuccess, getRequestId, parseIfMatch } from "@/lib/http";
import { actorFromPrincipal } from "@/lib/identity/audit";
import { requireStudioAction } from "@/lib/identity/studio-access";
import {
  PolicyLoadError,
  type PolicyRuleInput,
  PolicySetStateError,
  PolicyValidationError,
  PolicyVersionConflictError,
  createPolicyRevision,
  loadPolicySetAndRules,
} from "@/lib/permission/policy-queries";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /studio/api/permission-rules — 读取当前生效 Policy Revision 的规则（§30 / §33）。
 *
 * - 守卫：policy.read。
 * - 返回：defaultDecision + rules（含跨 Revision 稳定 ruleKey）+ rulesHash + Revision 元信息 +
 *   PolicySet.versionNo（ETag，§33）。
 * - fail-closed：Set 缺失 / 非 published / 跨租户 → 500。
 */
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  const r = await requireStudioAction(req, "policy.read");
  if (!r.ok) return r.response;
  const tenantId = r.principal.tenantId;

  let loaded: Awaited<ReturnType<typeof loadPolicySetAndRules>>;
  try {
    loaded = await loadPolicySetAndRules(tenantId);
  } catch (err) {
    if (err instanceof PolicyLoadError) {
      return apiError("POLICY_LOAD_FAILED", err.message, { requestId });
    }
    throw err;
  }

  return apiSuccess(
    {
      set: {
        id: loaded.set.id,
        policySetKey: loaded.set.policySetKey,
        lifecycleState: loaded.set.lifecycleState,
        versionNo: loaded.set.versionNo,
      },
      defaultDecision: loaded.defaultDecision,
      rules: loaded.rules.map((row) => ({
        id: row.id,
        ruleKey: row.ruleKey,
        toolPattern: row.toolPattern,
        argMatcher: row.argMatcherJson ?? null,
        decision: row.decision,
        scope: row.scopeJson,
        priority: row.priority,
        reason: row.reason,
      })),
      rulesHash: loaded.rulesHash,
      revision: {
        id: loaded.revision.id,
        revisionNo: loaded.revision.revisionNo,
        publishedAt: loaded.revision.publishedAt?.toISOString() ?? null,
      },
    },
    { headers: { [ETAG_HEADER]: String(loaded.set.versionNo) } },
  );
}

/**
 * PUT /studio/api/permission-rules — 发布新的 Policy Revision（§31 / §33 / §P3）。
 *
 * - 守卫：policy.publish。
 * - 只接受完整目标规则集合（§31：复制旧 rules 保留 ruleKey → 应用增删改）。
 * - 正式 API 只接受 allow/pause/block（§P3，Legacy allow/ask/deny 转换删除）。
 * - If-Match 必填（§33）；与 Set.versionNo 不匹配 → 412。
 * - 非法规则（toolPattern / decision / argMatcher / scope / priority）→ 400，fail-closed。
 * - 生命周期 disabled/retired → 409。
 * - 成功：单事务新 published Revision + 切 currentRevisionId + versionNo+1 +
 *   AuditEvent(policy.publish)（§31 / §35），返回新投影 + 新 ETag。
 */
export async function PUT(req: NextRequest) {
  const requestId = getRequestId(req);
  const r = await requireStudioAction(req, "policy.publish");
  if (!r.ok) return r.response;
  const principal = r.principal;

  const ifMatch = parseIfMatch(req);
  if (!ifMatch) {
    return apiError("IF_MATCH_REQUIRED", "缺少必填头 If-Match", { requestId });
  }
  const expectedVersionNo = Number(ifMatch);
  if (!Number.isInteger(expectedVersionNo) || expectedVersionNo < 1) {
    return apiError("REQUEST_SCHEMA_INVALID", "If-Match 不是合法 versionNo", { requestId });
  }

  let body: { defaultDecision?: unknown; rules?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError("INVALID_REQUEST", "请求体不是合法 JSON", { requestId });
  }

  let defaultDecision: "allow" | "pause" | "block";
  let rules: PolicyRuleInput[];
  try {
    defaultDecision = body?.defaultDecision as "allow" | "pause" | "block";
    rules = (body?.rules ?? []) as PolicyRuleInput[];
    // 校验由 createPolicyRevision 内的 validateRules/validateDefaultDecision 统一 fail-closed；
    // 这里仅做形状兜底，具体错误码由服务层 PolicyValidationError 返回。
  } catch {
    return apiError("INVALID_REQUEST", "请求体形状不合法", { requestId });
  }

  try {
    const result = await createPolicyRevision({
      tenantId: principal.tenantId,
      defaultDecision,
      rules,
      expectedVersionNo,
      actor: actorFromPrincipal(principal),
      requestId,
    });
    return apiSuccess(
      {
        set: {
          id: result.set.id,
          policySetKey: result.set.policySetKey,
          lifecycleState: result.set.lifecycleState,
          versionNo: result.set.versionNo,
        },
        defaultDecision: result.revision.defaultDecision,
        rules: result.rules.map((row) => ({
          id: row.id,
          ruleKey: row.ruleKey,
          toolPattern: row.toolPattern,
          argMatcher: row.argMatcherJson ?? null,
          decision: row.decision,
          scope: row.scopeJson,
          priority: row.priority,
          reason: row.reason,
        })),
        rulesHash: result.rulesHash,
        revision: {
          id: result.revision.id,
          revisionNo: result.revision.revisionNo,
          publishedAt: result.revision.publishedAt?.toISOString() ?? null,
        },
        auditEventId: result.auditEventId,
      },
      { headers: { [ETAG_HEADER]: String(result.set.versionNo) } },
    );
  } catch (err) {
    if (err instanceof PolicyVersionConflictError) {
      return apiError("ETAG_MISMATCH", err.message, { requestId });
    }
    if (err instanceof PolicySetStateError) {
      return apiError("POLICY_SET_STATE", err.message, { requestId });
    }
    if (err instanceof PolicyValidationError) {
      return apiError("POLICY_INVALID", err.message, { requestId });
    }
    if (err instanceof PolicyLoadError) {
      return apiError("POLICY_LOAD_FAILED", err.message, { requestId });
    }
    throw err;
  }
}
