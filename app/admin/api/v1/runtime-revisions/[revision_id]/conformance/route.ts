import { publishRuntimeRevisionThroughControlPlane } from "@/lib/compatibility/runtimes/publish-runtime-revision";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  etagHeader,
  getRequestId,
  parseIfMatch,
  v11Error,
  v11NotFound,
  v11Ok,
} from "@/lib/http";
import {
  type AdminPrincipal,
  RUNTIME_REVISION_ETAG_PREFIX,
  adminAuthErrorResponse,
  parseRuntimeRevisionEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11EtagMismatch,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET/POST /admin/api/v1/runtime-revisions/{revision_id}/conformance — RuntimeRevision conformance 结果（S05-C06）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/contracts/runtime-conformance.json（16 个 required_cases）
 * - ../v11-agentkit-platform/15-machine-contracts.md §5 L94-110（conformance 门禁协议）
 * - ../v11-agentkit-platform-development-plan/05-runtime-protocol-dispatch-and-agent-loop.md S05-C06
 *
 * 行为：
 * - GET：列出 Revision 的全部 conformance 结果（按 caseId 升序）。
 * - POST：提交 conformance 结果。可选 `publish=true` 同时发布 Revision（通过门禁后）。
 * - publish=true时，发布事实、Runtime指针、Audit、Outbox和幂等完成同事务提交。
 *
 * 身份与授权：
 * - 解析 admin 主体（SSO 管理员；CI/CD Service Identity 不允许 runtime.publish）。
 * - 校验 action scope: runtime.publish + resource { type: "runtime", id: revision.runtimeId }。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Revision 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - 缺少 Idempotency-Key（POST） → 400 REQUEST_SCHEMA_INVALID
 * - 缺少 If-Match（publish=true） → 400 REQUEST_SCHEMA_INVALID
 * - If-Match 不匹配 → 412 ETAG_MISMATCH
 * - Conformance 门禁失败 → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - Runtime 乐观锁冲突 → 412 ETAG_MISMATCH
 */
import {
  ALL_CONFORMANCE_CASES,
  type ConformanceCaseId,
  type ConformanceCaseResult,
  ConformanceGateError,
  validateConformanceGate,
} from "@/lib/v11/control-plane/runtime-conformance";
import {
  deleteConformanceResultsByRevision,
  listConformanceResultsByRevision,
  persistConformanceResults,
} from "@/lib/v11/control-plane/runtime-conformance-result-queries";
import { getRuntimeById } from "@/lib/v11/control-plane/runtime-queries";
import {
  RuntimeRevisionNotFoundError,
  RuntimeVersionConflictError,
  getRuntimeRevisionById,
} from "@/lib/v11/control-plane/runtime-revision-queries";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/v11/identity/audit";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  callerFromWorkloadPrincipal,
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/v11/identity/idempotency";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ revision_id: string }>;
}

/** 单个 conformance case 结果（请求体格式）。 */
interface ConformanceCaseInput {
  case_id: string;
  passed: boolean;
  reason?: string;
}

/** POST 请求体 schema。 */
interface ConformanceBody {
  /** conformance case 结果列表（至少包含 4 个 mandatory case）。 */
  conformance_results: ConformanceCaseInput[];
  /** Adapter 制品 digest（可选）。 */
  adapter_digest?: string;
  /** 测试环境标识（可选）。 */
  test_environment?: string;
  /** 证据引用（可选）。 */
  evidence_ref?: string;
  /** 是否同时发布 Revision（默认 false）。 */
  publish?: boolean;
  /** Runtime 乐观锁期望版本号（publish=true 时必填）。 */
  expected_version_no?: number;
}

/** 已知 conformance case id 集合（用于校验）。 */
const KNOWN_CASE_IDS: ReadonlySet<string> = new Set(ALL_CONFORMANCE_CASES);

/** 校验 POST 请求体。 */
function validateBody(body: unknown): body is ConformanceBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.conformance_results) || b.conformance_results.length === 0) return false;
  for (const item of b.conformance_results) {
    if (!item || typeof item !== "object") return false;
    const r = item as Record<string, unknown>;
    if (typeof r.case_id !== "string" || !KNOWN_CASE_IDS.has(r.case_id)) return false;
    if (typeof r.passed !== "boolean") return false;
    if (r.reason !== undefined && typeof r.reason !== "string") return false;
  }
  if (b.adapter_digest !== undefined && typeof b.adapter_digest !== "string") return false;
  if (b.test_environment !== undefined && typeof b.test_environment !== "string") return false;
  if (b.evidence_ref !== undefined && typeof b.evidence_ref !== "string") return false;
  if (b.publish !== undefined && typeof b.publish !== "boolean") return false;
  if (
    b.expected_version_no !== undefined &&
    (typeof b.expected_version_no !== "number" || !Number.isInteger(b.expected_version_no))
  )
    return false;
  return true;
}

/** 从主体提取幂等 caller。 */
function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

/** 把 ConformanceCaseInput[] 转为 ConformanceCaseResult[]。 */
function toConformanceCaseResults(inputs: ConformanceCaseInput[]): ConformanceCaseResult[] {
  return inputs.map((input) => ({
    caseId: input.case_id as ConformanceCaseId,
    passed: input.passed,
    reason: input.reason,
  }));
}

/** 把持久化的 ConformanceResult 行转为响应体格式。 */
function formatConformanceResult(row: {
  caseId: string;
  passed: boolean;
  reason: string | null;
  adapterDigest: string | null;
  testEnvironment: string | null;
  evidenceRef: string | null;
  testedAt: Date;
}) {
  return {
    case_id: row.caseId,
    passed: row.passed,
    reason: row.reason,
    adapter_digest: row.adapterDigest,
    test_environment: row.testEnvironment,
    evidence_ref: row.evidenceRef,
    tested_at: row.testedAt.toISOString(),
  };
}

// ─── GET：列出 conformance 结果 ───────────────────────────

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { revision_id: revisionId } = await context.params;

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Revision 存在（跨租户隐藏为 404）
  const revision = await getRuntimeRevisionById(revisionId);
  if (!revision) {
    return v11NotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
  }

  // 3. 校验 Revision 属于当前租户的 Runtime（跨租户隐藏为 404）
  const runtime = await getRuntimeById(principal.tenantId, revision.runtimeId);
  if (!runtime) {
    return v11NotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
  }

  // 4. 校验 action scope（resource = runtime, id = runtimeId）
  const scopeResult = await requireAdminActionScope(
    principal,
    "runtime.publish",
    { type: "runtime", id: revision.runtimeId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 5. 列出 conformance 结果
  const results = await listConformanceResultsByRevision(revisionId);

  return v11Ok(
    {
      runtime_revision_id: revisionId,
      revision_state: revision.revisionState,
      results: results.map(formatConformanceResult),
    },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

// ─── POST：提交 conformance 结果（可选发布） ─────────────

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { revision_id: revisionId } = await context.params;

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(requestId, "请求体非法：缺少 conformance_results 或字段类型不匹配");
  }

  // 4. 校验 Revision 存在（跨租户隐藏为 404）
  const revision = await getRuntimeRevisionById(revisionId);
  if (!revision) {
    return v11NotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
  }

  // 5. 校验 Revision 属于当前租户的 Runtime（跨租户隐藏为 404）
  const runtime = await getRuntimeById(principal.tenantId, revision.runtimeId);
  if (!runtime) {
    return v11NotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
  }

  // 6. 校验 action scope（resource = runtime, id = runtimeId）
  const scopeResult = await requireAdminActionScope(
    principal,
    "runtime.publish",
    { type: "runtime", id: revision.runtimeId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 7. publish=true 时的额外校验
  const shouldPublish = body.publish === true;
  let expectedVersionNo: number | null = null;
  let ifMatchEtag: string | null = null;

  if (shouldPublish) {
    // 必填 expected_version_no
    if (typeof body.expected_version_no !== "number") {
      return v11SchemaInvalid(requestId, "publish=true 时必填 expected_version_no");
    }
    expectedVersionNo = body.expected_version_no;

    // 必填 If-Match（RuntimeRevision ETag）
    const ifMatch = parseIfMatch(request);
    if (!ifMatch) {
      return v11SchemaInvalid(requestId, "publish=true 时缺少必填头 If-Match");
    }
    try {
      parseRuntimeRevisionEtag(ifMatch);
    } catch (err) {
      return v11SchemaInvalid(
        requestId,
        err instanceof Error ? err.message : "If-Match ETag 格式非法",
      );
    }
    // 校验 If-Match ETag 与 Revision 当前 revisionNo 一致
    const currentEtag = `${RUNTIME_REVISION_ETAG_PREFIX}${revision.revisionNo}`;
    if (ifMatch !== currentEtag) {
      return v11EtagMismatch(requestId, `If-Match ${ifMatch} 与当前 ETag ${currentEtag} 不匹配`);
    }
    ifMatchEtag = ifMatch;
  }

  // 8. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `runtime.conformance:${revisionId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 9. 处理幂等结果
  if (outcome.kind === "replay") {
    return buildReplayResponse(outcome.record, requestId);
  }
  if (outcome.kind === "in_flight" || outcome.kind === "conflict") {
    return buildIdempotencyErrorResponse({
      record: outcome.kind === "conflict" ? outcome.existingRecord : outcome.record,
      reason: outcome.kind === "conflict" ? "conflict" : "in_flight",
      requestId,
    });
  }

  let recordId = outcome.record.id;
  if (outcome.kind === "retry_allowed") {
    const reset = await prepareRetryForFailedRecord({
      record: outcome.record,
      requestHash,
    });
    if (!reset) {
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  }

  // 10. 执行业务
  try {
    const conformanceResults = toConformanceCaseResults(body.conformance_results);
    const options = {
      adapterDigest: body.adapter_digest ?? null,
      testEnvironment: body.test_environment ?? null,
      evidenceRef: body.evidence_ref ?? null,
    };

    let publishedResult = null;
    if (shouldPublish && expectedVersionNo !== null) {
      publishedResult = await publishRuntimeRevisionThroughControlPlane({
        tenantId: principal.tenantId,
        revisionId,
        runtimeExpectedVersionNo: expectedVersionNo,
        conformanceResults,
        conformanceOptions: options,
        actor: actorFromAdminPrincipal(principal),
        requestId,
        idempotencyKey,
        idempotency: {
          recordId,
          httpStatus: 200,
          responseRef: revisionId,
          serializeResponse: (published) =>
            JSON.stringify({
              runtime_revision_id: revisionId,
              revision_state: published.revision.revisionState,
              published: true,
              published_at: published.revision.publishedAt?.toISOString() ?? null,
              etag: `${RUNTIME_REVISION_ETAG_PREFIX}${published.revision.revisionNo}`,
              results: published.conformanceResults.map(formatConformanceResult),
            }),
        },
      });
    } else {
      // publish=false：只持久化 conformance 结果（不发布）
      // 先校验门禁，失败则返回 422（不持久化失败结果）
      const gateResult = validateConformanceGate(conformanceResults);
      if (!gateResult.passed) {
        await failRecord(recordId);
        return v11Error(
          "BUSINESS_CONSTRAINT_VIOLATION",
          `Conformance 门禁失败，缺失/失败的 mandatory case：${gateResult.failedCases.join(", ")}`,
          { requestId },
        );
      }
      // 先清空旧结果，再持久化新结果（重新测试场景）
      await deleteConformanceResultsByRevision(revisionId);
      await persistConformanceResults({
        tenantId: principal.tenantId,
        runtimeRevisionId: revisionId,
        results: conformanceResults,
        ...options,
      });
    }

    // 11. 查询最新 conformance 结果
    const publishedRevision = publishedResult?.revision ?? null;
    const results =
      publishedResult?.conformanceResults ?? (await listConformanceResultsByRevision(revisionId));

    const responseBody = {
      runtime_revision_id: revisionId,
      revision_state: publishedRevision?.revisionState ?? revision.revisionState,
      published: shouldPublish,
      published_at: publishedRevision?.publishedAt?.toISOString() ?? null,
      etag: publishedRevision
        ? `${RUNTIME_REVISION_ETAG_PREFIX}${publishedRevision.revisionNo}`
        : ifMatchEtag,
      results: results.map(formatConformanceResult),
    };

    if (!publishedResult) {
      await completeRecord({
        recordId,
        httpStatus: 200,
        responseRedactedJson: JSON.stringify(responseBody),
      });
    }

    const headers: Record<string, string> = { [REQUEST_ID_HEADER]: requestId };
    if (publishedRevision) {
      Object.assign(headers, etagHeader(responseBody.etag as string));
    }

    return v11Ok(responseBody, { status: 200, headers });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof ConformanceGateError) {
      return v11Error(
        "BUSINESS_CONSTRAINT_VIOLATION",
        `Conformance 门禁失败，缺失/失败的 mandatory case：${err.failedCases.join(", ")}`,
        { requestId },
      );
    }
    if (err instanceof RuntimeVersionConflictError) {
      return v11EtagMismatch(
        requestId,
        `Runtime ${err.runtimeId} versionNo 不匹配（期望 ${err.expectedVersionNo}），并发冲突`,
      );
    }
    if (err instanceof RuntimeRevisionNotFoundError) {
      return v11NotFound(requestId, err.message);
    }
    throw err;
  }
}
