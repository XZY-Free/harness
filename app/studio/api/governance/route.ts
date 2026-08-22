import { GovernanceConfigValidationError, validateGovernanceConfig } from "@/lib/governance/config";
import {
  GovernanceLoadError,
  loadGovernanceConfigFromDB,
} from "@/lib/governance/governance-repository";
import {
  GovernanceSetStateError,
  GovernanceVersionConflictError,
  publishGovernanceConfig,
} from "@/lib/governance/publish-governance-config";
import { ETAG_HEADER, getRequestId, jsonError, jsonOk, parseIfMatch } from "@/lib/http";
import { actorFromPrincipal } from "@/lib/identity/audit";
import { requireStudioAction } from "@/lib/identity/studio-access";
import type { GovernanceConfig } from "@/lib/persistence/schema/governance-config";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /studio/api/governance — 读取当前生效 Governance 配置（§5 / §29 / §33）。
 *
 * - 守卫：policy.read（读取；§34 未定义 governance.read，复用 policy.read）。
 * - 返回：config + configDigest + revision 元信息 + Set.versionNo（ETag，§33）。
 * - fail-closed：DB 缺失/非 published/digest 错/跨租户 → 500（绝不回退 INITIAL_GOVERNANCE_CONFIG）。
 */
export async function GET(req: NextRequest) {
  const r = await requireStudioAction(req, "policy.read");
  if (!r.ok) return r.response;
  const tenantId = r.principal.tenantId;

  let loaded: Awaited<ReturnType<typeof loadGovernanceConfigFromDB>>;
  try {
    loaded = await loadGovernanceConfigFromDB(tenantId);
  } catch (err) {
    if (err instanceof GovernanceLoadError) {
      return jsonError(500, "governance_load_failed", err.message);
    }
    throw err;
  }

  return jsonOk(
    {
      set: {
        id: loaded.set.id,
        configSetKey: loaded.set.configSetKey,
        lifecycleState: loaded.set.lifecycleState,
        versionNo: loaded.set.versionNo,
      },
      config: loaded.config,
      configDigest: loaded.configDigest,
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
 * PUT /studio/api/governance — 发布新的 Governance 配置（§32 / §33）。
 *
 * - 守卫：governance.config.publish（§34）。
 * - If-Match 必填（§33）；与 Set.versionNo 不匹配 → 412。
 * - 非法 config → 400（§55.1 invalid config）。
 * - 生命周期 disabled/retired → 409。
 * - 成功：单事务新建 published Revision + 切 currentRevisionId + versionNo+1 +
 *   AuditEvent(governance.config.publish)（§32 / §35），返回新投影 + 新 ETag。
 */
export async function PUT(req: NextRequest) {
  const requestId = getRequestId(req);
  const r = await requireStudioAction(req, "governance.config.publish");
  if (!r.ok) return r.response;
  const principal = r.principal;

  // If-Match 必填（§33）。
  const ifMatch = parseIfMatch(req);
  if (!ifMatch) {
    return jsonError(400, "if_match_required", "缺少必填头 If-Match");
  }
  const expectedVersionNo = Number(ifMatch);
  if (!Number.isInteger(expectedVersionNo) || expectedVersionNo < 1) {
    return jsonError(400, "if_match_invalid", "If-Match 不是合法 versionNo");
  }

  let body: { config?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_body", "请求体不是合法 JSON");
  }

  let newConfig: GovernanceConfig;
  try {
    validateGovernanceConfig(body?.config);
    newConfig = body.config as GovernanceConfig;
  } catch (err) {
    if (err instanceof GovernanceConfigValidationError) {
      return jsonError(400, "governance_config_invalid", err.message);
    }
    throw err;
  }

  try {
    const result = await publishGovernanceConfig({
      tenantId: principal.tenantId,
      newConfig,
      expectedVersionNo,
      actor: actorFromPrincipal(principal),
      requestId,
    });
    return jsonOk(
      {
        set: {
          id: result.set.id,
          configSetKey: result.set.configSetKey,
          lifecycleState: result.set.lifecycleState,
          versionNo: result.set.versionNo,
        },
        config: result.revision.configJson,
        configDigest: result.configDigest,
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
    if (err instanceof GovernanceVersionConflictError) {
      return jsonError(412, "etag_mismatch", err.message);
    }
    if (err instanceof GovernanceSetStateError) {
      return jsonError(409, "governance_set_state", err.message);
    }
    if (err instanceof GovernanceLoadError) {
      return jsonError(500, "governance_load_failed", err.message);
    }
    throw err;
  }
}
