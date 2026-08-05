import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  etagHeader,
  getRequestId,
  parseIfMatch,
  resourceNotFound,
} from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  callerFromWorkloadPrincipal,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";
import { publishRuntimeRevisionThroughControlPlane } from "@/lib/runtimes/application/publish-runtime-revision-service";
import {
  listRuntimeConformanceCaseResults,
  listRuntimeConformanceRuns,
  recordRuntimeConformanceRun,
} from "@/lib/runtimes/application/runtime-conformance-runs";
import { RuntimeConformanceCaseFailedError } from "@/lib/runtimes/domain/runtime-conformance";
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
 * - 缺少 artifact_attestation_id（publish=true） → 400 REQUEST_SCHEMA_INVALID
 * - 缺少 If-Match（publish=true） → 400 REQUEST_SCHEMA_INVALID
 * - If-Match 不匹配 → 412 ETAG_MISMATCH
 * - Attestation 不存在或已撤销 → 409 ARTIFACT_NOT_VERIFIED / ARTIFACT_ATTESTATION_REVOKED
 * - Attestation 绑定或 Digest 不匹配 → 409 ARTIFACT_BINDING_MISMATCH
 * - Conformance 绑定不一致 → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - Conformance 门禁失败 → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - Runtime 乐观锁冲突 → 412 ETAG_MISMATCH
 */
import type { RuntimeConformanceReport } from "@/lib/runtimes/domain/runtime-conformance-run";
import {
  RuntimeConformanceBindingError,
  RuntimeConformanceTrustError,
} from "@/lib/runtimes/domain/runtime-conformance-run";
import {
  RuntimeArtifactAttestationInvalidError,
  RuntimeArtifactAttestationRequiredError,
  RuntimeConformanceRunInvalidError,
} from "@/lib/runtimes/domain/runtime-revision-publication-policy";
import { getRuntimeById } from "@/lib/runtimes/persistence/runtime-queries";
import {
  RuntimeRevisionNotFoundError,
  getRuntimeRevisionById,
} from "@/lib/runtimes/persistence/runtime-revision-queries";
import {
  type AdminPrincipal,
  RUNTIME_REVISION_ETAG_PREFIX,
  adminAuthErrorResponse,
  etagMismatchTable,
  parseRuntimeRevisionEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ revision_id: string }>;
}

/** 单个 conformance case 结果（请求体格式）。 */
/** POST 请求体 schema。 */
interface ConformanceBody {
  /** 隔离 Runner 生成并签名的完整报告；管理员不能自行提交 passed。 */
  runner_report: RuntimeConformanceReport;
  runner_signature: string;
  /** 是否同时发布 Revision（默认 false）。 */
  publish?: boolean;
  /** Runtime 乐观锁期望版本号（publish=true 时必填）。 */
  expected_version_no?: number;
  /** 已验证且与 Revision 绑定一致的 ArtifactAttestation ID（publish=true 时必填）。 */
  artifact_attestation_id?: string;
}

/** 校验 POST 请求体基础字段。 */
function validateBody(body: unknown): body is ConformanceBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (!b.runner_report || typeof b.runner_report !== "object") return false;
  if (typeof b.runner_signature !== "string") return false;
  if (b.publish !== undefined && typeof b.publish !== "boolean") return false;
  if (
    b.expected_version_no !== undefined &&
    (typeof b.expected_version_no !== "number" || !Number.isInteger(b.expected_version_no))
  )
    return false;
  if (b.artifact_attestation_id !== undefined && typeof b.artifact_attestation_id !== "string")
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
    return resourceNotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
  }

  // 3. 校验 Revision 属于当前租户的 Runtime（跨租户隐藏为 404）
  const runtime = await getRuntimeById(principal.tenantId, revision.runtimeId);
  if (!runtime) {
    return resourceNotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
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
  const runs = await listRuntimeConformanceRuns(principal.tenantId, revisionId);
  const latestRun = runs[0] ?? null;
  const results = latestRun ? await listRuntimeConformanceCaseResults(latestRun.id) : [];

  return apiSuccess(
    {
      runtime_revision_id: revisionId,
      revision_state: revision.revisionState,
      conformance_run_id: latestRun?.id ?? null,
      overall_result: latestRun?.overallResult ?? null,
      results: results.map((row) => ({
        case_id: row.caseId,
        passed: row.passed,
        reason: row.reason,
        evidence_digest: row.evidenceDigest,
      })),
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
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(requestId, "请求体非法：缺少 conformance_results 或字段类型不匹配");
  }

  // 4. 校验 Revision 存在（跨租户隐藏为 404）
  const revision = await getRuntimeRevisionById(revisionId);
  if (!revision) {
    return resourceNotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
  }

  // 5. 校验 Revision 属于当前租户的 Runtime（跨租户隐藏为 404）
  const runtime = await getRuntimeById(principal.tenantId, revision.runtimeId);
  if (!runtime) {
    return resourceNotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
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
    // 必填 artifact_attestation_id
    if (!body.artifact_attestation_id) {
      return schemaInvalidTable(requestId, "publish=true 时必填 artifact_attestation_id");
    }
    // 必填 expected_version_no
    if (typeof body.expected_version_no !== "number") {
      return schemaInvalidTable(requestId, "publish=true 时必填 expected_version_no");
    }
    expectedVersionNo = body.expected_version_no;

    // 必填 If-Match（RuntimeRevision ETag）
    const ifMatch = parseIfMatch(request);
    if (!ifMatch) {
      return schemaInvalidTable(requestId, "publish=true 时缺少必填头 If-Match");
    }
    try {
      parseRuntimeRevisionEtag(ifMatch);
    } catch (err) {
      return schemaInvalidTable(
        requestId,
        err instanceof Error ? err.message : "If-Match ETag 格式非法",
      );
    }
    // 校验 If-Match ETag 与 Revision 当前 revisionNo 一致
    const currentEtag = `${RUNTIME_REVISION_ETAG_PREFIX}${revision.revisionNo}`;
    if (ifMatch !== currentEtag) {
      return etagMismatchTable(requestId, `If-Match ${ifMatch} 与当前 ETag ${currentEtag} 不匹配`);
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
    const recorded = await recordRuntimeConformanceRun({
      tenantId: principal.tenantId,
      runtimeRevisionId: revisionId,
      report: body.runner_report,
      signature: body.runner_signature,
      idempotencyKey,
      requestId,
      actor: actorFromAdminPrincipal(principal),
      idempotency: shouldPublish
        ? undefined
        : {
            recordId,
            httpStatus: 200,
            responseRef: revisionId,
            serializeResponse: (result) =>
              JSON.stringify({
                runtime_revision_id: revisionId,
                revision_state: revision.revisionState,
                published: false,
                published_at: null,
                etag: null,
                conformance_run_id: result.run.id,
                results: result.caseResults.map((row) =>
                  formatConformanceResult({
                    caseId: row.caseId,
                    passed: row.passed,
                    reason: row.reason,
                    adapterDigest: result.run.runnerArtifactDigest,
                    testEnvironment: result.run.testEnvironmentRevision,
                    evidenceRef: row.evidenceDigest,
                    testedAt: result.run.completedAt,
                  }),
                ),
              }),
          },
    });

    let publishedResult = null;
    if (shouldPublish && expectedVersionNo !== null) {
      publishedResult = await publishRuntimeRevisionThroughControlPlane({
        tenantId: principal.tenantId,
        revisionId,
        runtimeExpectedVersionNo: expectedVersionNo,
        conformanceRunId: recorded.run.id,
        attestationId: body.artifact_attestation_id!,
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
              conformance_run_id: recorded.run.id,
              results: published.conformanceResults.map(formatConformanceResult),
            }),
        },
      });
    } else {
      // publish=false 仅记录不可变 Run；失败结果同样保留为测试事实。
    }

    // 11. 查询最新 conformance 结果
    const publishedRevision = publishedResult?.revision ?? null;
    const results = recorded.caseResults.map((row) => ({
      caseId: row.caseId,
      passed: row.passed,
      reason: row.reason,
      adapterDigest: recorded.run.runnerArtifactDigest,
      testEnvironment: recorded.run.testEnvironmentRevision,
      evidenceRef: row.evidenceDigest,
      testedAt: recorded.run.completedAt,
    }));

    const responseBody = {
      runtime_revision_id: revisionId,
      revision_state: publishedRevision?.revisionState ?? revision.revisionState,
      published: shouldPublish,
      published_at: publishedRevision?.publishedAt?.toISOString() ?? null,
      etag: publishedRevision
        ? `${RUNTIME_REVISION_ETAG_PREFIX}${publishedRevision.revisionNo}`
        : ifMatchEtag,
      conformance_run_id: recorded.run.id,
      results: results.map(formatConformanceResult),
    };

    const headers: Record<string, string> = { [REQUEST_ID_HEADER]: requestId };
    if (publishedRevision) {
      Object.assign(headers, etagHeader(responseBody.etag as string));
    }

    return apiSuccess(responseBody, { status: 200, headers });
  } catch (err) {
    await failRecord(recordId);

    if (
      err instanceof RuntimeConformanceTrustError ||
      err instanceof RuntimeConformanceBindingError ||
      err instanceof RuntimeConformanceRunInvalidError
    ) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof RuntimeArtifactAttestationRequiredError) {
      return schemaInvalidTable(requestId, err.message);
    }
    if (err instanceof RuntimeArtifactAttestationInvalidError) {
      // 区分撤销和绑定不匹配
      if (err.reason.includes("已撤销")) {
        return apiError("ARTIFACT_ATTESTATION_REVOKED", err.message, { requestId });
      }
      if (
        err.reason.includes("绑定") ||
        err.reason.includes("Digest") ||
        err.reason.includes("不一致")
      ) {
        return apiError("ARTIFACT_BINDING_MISMATCH", err.message, { requestId });
      }
      return apiError("ARTIFACT_NOT_VERIFIED", err.message, { requestId });
    }
    if (err instanceof RuntimeConformanceCaseFailedError) {
      return apiError(
        "BUSINESS_CONSTRAINT_VIOLATION",
        `Conformance 门禁失败，缺失/失败的 mandatory case：${err.failedCases.join(", ")}`,
        { requestId },
      );
    }
    if (err instanceof RuntimeRevisionNotFoundError) {
      return resourceNotFound(requestId, err.message);
    }
    throw err;
  }
}
