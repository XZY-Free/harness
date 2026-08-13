import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  getBuilderKeyRegistry,
  getManagedArtifactStore,
} from "@/lib/artifacts/infrastructure/artifact-store-provider";
/**
 * POST /admin/api/v1/artifact-attestations:verify — 验证制品证明（S03-C05）。
 *
 * 事实源：docs/contracts/openapi.json（post_admin_api_v1_artifact_attestations_verify）、
 *         docs/architecture/security.md §4.1-4.2、
 *         docs/architecture/api-and-events.md §6、
 *         docs/architecture/agent-control-plane.md S03-W05。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员或 CI/CD Service Identity）。
 * - 校验 action scope: artifact.attestation.verify + resource { type: "artifact_type", id: artifact_type }。
 * - 校验 Idempotency-Key（必填）。
 * - 调用 verifyAndPersistAttestation：独立校验签名/SBOM/provenance + 持久化 + 审计。
 *   - ManagedArtifactStore 与 BuilderKeyRegistry 通过 artifact-store-config 注入。
 *   - 调用方只能提交引用，不能自报 verification_state（零信任供应链）。
 * - completeRecord + 返回 200 + attestation 投影。
 *
 * 契约扩展：OpenAPI 请求体未列 builder_identity，但 verifyArtifactAttestation 需要 builder_identity
 * 查白名单公钥（无 builder_identity 则无法验签）。本 route 接受 builder_identity 作为必填请求体字段。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - 验证失败 → 422 ARTIFACT_ATTESTATION_FAILED（失败记录已持久化 + 审计已写）
 */
import {
  ArtifactAttestationFailedError,
  verifyAndPersistAttestation,
} from "@/lib/artifacts/persistence/artifact-attestation-queries";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
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
import { ARTIFACT_TYPES, type ArtifactAttestation } from "@/lib/persistence/schema/artifact";

export const dynamic = "force-dynamic";

/**
 * 请求体 schema。
 *
 * OpenAPI 契约字段：artifact_type, artifact_revision_id, artifact_digest,
 * dsse_envelope_ref（Predicate 含全量供应链证据，sbom_ref/provenance_ref 由签名 Predicate 提供）。
 * 扩展字段：builder_identity（验证必需）、policy_revision_id（可选）。
 */
interface VerifyBody {
  artifact_type: string;
  artifact_revision_id: string;
  artifact_digest: string;
  dsse_envelope_ref: string;
  builder_identity: string;
  policy_revision_id?: string;
}

function projectResponse(attestation: ArtifactAttestation) {
  return {
    attestation_id: attestation.id,
    artifact_revision_id: attestation.artifactRevisionId,
    artifact_digest: attestation.artifactDigest,
    verification_state: attestation.verificationState,
    builder_identity: attestation.builderIdentity,
    policy_revision_id: attestation.policyRevisionId,
    verified_at: attestation.verifiedAt?.toISOString() ?? null,
  };
}

/** 校验请求体。 */
function validateBody(body: unknown): body is VerifyBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (
    typeof b.artifact_type !== "string" ||
    !(ARTIFACT_TYPES as readonly string[]).includes(b.artifact_type)
  ) {
    return false;
  }
  if (typeof b.artifact_revision_id !== "string" || b.artifact_revision_id.length === 0)
    return false;
  if (typeof b.artifact_digest !== "string" || b.artifact_digest.length === 0) return false;
  if (typeof b.dsse_envelope_ref !== "string" || b.dsse_envelope_ref.length === 0) return false;
  if (typeof b.builder_identity !== "string" || b.builder_identity.length === 0) return false;
  if (b.policy_revision_id !== undefined && typeof b.policy_revision_id !== "string") return false;
  return true;
}

/** 从主体提取幂等 caller。 */
function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

/** 从主体提取审计 actor。 */
function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

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
    return schemaInvalidTable(
      requestId,
      "请求体非法：缺少 artifact_type/artifact_revision_id/artifact_digest/dsse_envelope_ref/builder_identity",
    );
  }

  // 4. 校验 action scope（resource = artifact_type, id = body.artifact_type）
  const scopeResult = await requireAdminActionScope(
    principal,
    "artifact.attestation.verify",
    { type: "artifact_type", id: body.artifact_type },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  // commandScope 仅按 artifact_revision_id 限定（与其它 route 的 `action.resource:${id}` 模式一致）。
  // artifact_digest 已通过 requestHash 体现，避免 commandScope 超过 varchar(128)。
  const commandScope = `artifact.attestation.verify:${body.artifact_revision_id}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 6. 处理幂等结果
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

  // 7. 执行业务：独立校验 + 持久化 + 审计
  try {
    const store = getManagedArtifactStore();
    const builderKeys = getBuilderKeyRegistry();

    const attestation = await verifyAndPersistAttestation(
      {
        tenantId: principal.tenantId,
        artifactType: body.artifact_type,
        artifactRevisionId: body.artifact_revision_id,
        artifactDigest: body.artifact_digest,
        dsseEnvelopeRef: body.dsse_envelope_ref,
        builderIdentity: body.builder_identity,
        policyRevisionId: body.policy_revision_id,
      },
      store,
      builderKeys,
      actorFromAdminPrincipal(principal),
      requestId,
      {
        recordId,
        httpStatus: (state) => (state === "verified" ? 200 : 422),
        serializeResponse: (attestation) =>
          JSON.stringify(
            attestation.verificationState === "verified"
              ? projectResponse(attestation)
              : {
                  error: {
                    code: "ARTIFACT_ATTESTATION_FAILED",
                    message: `制品证明验证失败（failure_code=${attestation.failureCode}）`,
                    request_id: requestId,
                    retryable: false,
                  },
                },
          ),
      },
    );

    const responseBody = projectResponse(attestation);

    return apiSuccess(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof ArtifactAttestationFailedError) {
      return apiError(
        "ARTIFACT_ATTESTATION_FAILED",
        `制品证明验证失败（failure_code=${err.failureCode}）`,
        { requestId },
      );
    }
    throw err;
  }
}
