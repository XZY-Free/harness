/**
 * POST /gateway/v1/memory-candidates — 提交 Memory Candidate（阶段 7 S07-C03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §10（写入路径）、§11（禁止内容与用户控制）。
 * - ../v11-agentkit-platform/10-core-data-model.md §7.5（memory_candidate / memory_entry / memory_source）。
 * - ../v11-agentkit-platform/13-memory-and-job-api.md §2（Memory Candidate API）。
 * - ../v11-agentkit-platform-development-plan/07-context-memory-and-knowledge.md S07-W04。
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=gateway，绑定 invocation）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（source / proposed_scope / memory_type / content / content_hash / sensitivity_class）。
 * - invocationId 来自 Token claims，不信任请求体（请求体的 invocation_id 仅用于校验一致性）。
 * - 校验 content_hash 与 content.text 一致（若 text 提供）。
 * - 计算 candidate_key，检查已存在 Candidate（幂等去重）。
 * - 评估 Memory Policy：accepted / rejected / needs_review。
 *   - accepted：同事务写 candidate + entry + source。
 *   - rejected：销毁正文，不创建 entry。
 *   - needs_review：等待管理员复核。
 * - completeRecord + 返回 201 + candidate 投影。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - 请求体 invocation_id 与 Token invocationId 不一致 → 400 REQUEST_SCHEMA_INVALID
 * - content_hash 与 content.text 不一致 → 409 MEMORY_CONTENT_HASH_MISMATCH
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 *
 * 边界：
 * - Secret/Token/Cookie/私钥直接 rejected，正文销毁，响应不回显。
 * - Organization scope 一律 needs_review。
 * - accepted 与 MemoryEntry upsert 同事务；MemorySource 关联同事务；索引异步。
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
} from "@/lib/http";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromWorkloadPrincipal,
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";
import type { WorkloadPrincipal } from "@/lib/identity/resolver";
import {
  MEMORY_SCOPE_TYPES,
  type MemoryCandidate,
  type MemoryScopeType,
  SENSITIVITY_CLASSES,
  type SensitivityClass,
} from "@/lib/persistence/schema/memory";
import {
  computeCandidateKey,
  createMemoryCandidateWithEntry,
  deriveSourceFromCandidate,
  evaluateMemoryPolicy,
  findMemoryCandidateByCandidateKey,
  insertMemoryCandidate,
  isValidMemoryContentHash,
  verifyMemoryContentHash,
} from "@/lib/v11/context/memory-queries";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/v11/gateway/route-helpers";

export const dynamic = "force-dynamic";

/** 大小限制。 */
const MAX_CONTENT_REDACTED_LENGTH = 100_000;
const MAX_CONTENT_REF_LENGTH = 512;
const MAX_MEMORY_TYPE_LENGTH = 64;

/** 合法 scope type 集合。 */
const VALID_SCOPE_TYPES: ReadonlySet<string> = new Set(MEMORY_SCOPE_TYPES);
const VALID_SENSITIVITY_CLASSES: ReadonlySet<string> = new Set(SENSITIVITY_CLASSES);

/** 请求体 schema。 */
interface MemoryCandidateBody {
  invocation_id: string;
  source: {
    thread_id?: string;
    turn_id?: string;
    item_id?: string;
    job_id?: string;
    artifact_id?: string;
    /** 来源事实自身的 hash（sha256: 前缀 + 64 hex）；可选，缺省回落到 content_hash。 */
    hash?: string;
  };
  proposed_scope: {
    type: string;
    ref?: string;
  };
  memory_type: string;
  content: {
    text?: string;
    content_ref?: string;
  };
  content_hash: string;
  sensitivity_class: string;
  /** 提交理由码（USER_EXPLICIT/REPEATED_PREFERENCE/PROJECT_FACT/TASK_DECISION 等）。 */
  rationale_code: string;
}

/** 校验请求体结构。返回 [valid, errorMessage, parsed]。 */
function validateBody(
  body: unknown,
  tokenInvocationId: string,
): [boolean, string, MemoryCandidateBody | null] {
  if (!body || typeof body !== "object") {
    return [false, "请求体必须是 JSON 对象", null];
  }
  const b = body as Record<string, unknown>;

  // invocation_id 必填，且必须与 Token invocationId 一致
  if (typeof b.invocation_id !== "string" || b.invocation_id.length === 0) {
    return [false, "invocation_id 必填且非空", null];
  }
  if (b.invocation_id !== tokenInvocationId) {
    return [false, "invocation_id 与 Workload Token 绑定的 Invocation 不一致", null];
  }

  // source 必填，对象
  if (!b.source || typeof b.source !== "object") {
    return [false, "source 必填且为对象", null];
  }
  const source = b.source as Record<string, unknown>;
  if (source.thread_id !== undefined && source.thread_id !== null) {
    if (typeof source.thread_id !== "string" || source.thread_id.length === 0) {
      return [false, "source.thread_id 必须是非空字符串", null];
    }
  }
  if (source.turn_id !== undefined && source.turn_id !== null) {
    if (typeof source.turn_id !== "string" || source.turn_id.length === 0) {
      return [false, "source.turn_id 必须是非空字符串", null];
    }
  }
  // item_id / job_id / artifact_id 恰一个非空
  const itemId = source.item_id;
  const jobId = source.job_id;
  const artifactId = source.artifact_id;
  const nonEmptyCount = [itemId, jobId, artifactId].filter((v) => v != null && v !== "").length;
  if (nonEmptyCount !== 1) {
    return [false, "source.item_id / source.job_id / source.artifact_id 恰一个非空", null];
  }
  for (const [key, val] of [
    ["item_id", itemId],
    ["job_id", jobId],
    ["artifact_id", artifactId],
  ] as const) {
    if (val !== undefined && val !== null) {
      if (typeof val !== "string" || val.length === 0) {
        return [false, `source.${key} 必须是非空字符串`, null];
      }
    }
  }
  // source.hash 可选；若提供必须是 sha256:<64 hex>
  if (source.hash !== undefined && source.hash !== null) {
    if (typeof source.hash !== "string" || !isValidMemoryContentHash(source.hash)) {
      return [false, "source.hash 必须是 sha256:<64 hex> 格式", null];
    }
  }

  // proposed_scope 必填，对象
  if (!b.proposed_scope || typeof b.proposed_scope !== "object") {
    return [false, "proposed_scope 必填且为对象", null];
  }
  const scope = b.proposed_scope as Record<string, unknown>;
  if (typeof scope.type !== "string" || !VALID_SCOPE_TYPES.has(scope.type)) {
    return [false, `proposed_scope.type 必须是 ${MEMORY_SCOPE_TYPES.join(" / ")} 之一`, null];
  }
  if (scope.ref !== undefined && scope.ref !== null) {
    if (typeof scope.ref !== "string" || scope.ref.length === 0) {
      return [false, "proposed_scope.ref 必须是非空字符串", null];
    }
  }

  // memory_type 必填，非空字符串
  if (typeof b.memory_type !== "string" || b.memory_type.length === 0) {
    return [false, "memory_type 必填且非空", null];
  }
  if (b.memory_type.length > MAX_MEMORY_TYPE_LENGTH) {
    return [false, `memory_type 超过最大长度 ${MAX_MEMORY_TYPE_LENGTH}`, null];
  }

  // content 必填，对象
  if (!b.content || typeof b.content !== "object") {
    return [false, "content 必填且为对象", null];
  }
  const content = b.content as Record<string, unknown>;
  if (typeof content.text !== "string" && typeof content.content_ref !== "string") {
    return [false, "content.text 与 content.content_ref 至少一个非空", null];
  }
  if (content.text !== undefined) {
    if (typeof content.text !== "string") {
      return [false, "content.text 必须是字符串", null];
    }
    if (content.text.length > MAX_CONTENT_REDACTED_LENGTH) {
      return [false, `content.text 超过最大长度 ${MAX_CONTENT_REDACTED_LENGTH}`, null];
    }
  }
  if (content.content_ref !== undefined) {
    if (typeof content.content_ref !== "string" || content.content_ref.length === 0) {
      return [false, "content.content_ref 必须是非空字符串", null];
    }
    if (content.content_ref.length > MAX_CONTENT_REF_LENGTH) {
      return [false, `content.content_ref 超过最大长度 ${MAX_CONTENT_REF_LENGTH}`, null];
    }
  }

  // content_hash 必填，sha256: 前缀 + 64 hex
  if (typeof b.content_hash !== "string" || !isValidMemoryContentHash(b.content_hash)) {
    return [false, "content_hash 必须是 sha256:<64 hex> 格式", null];
  }

  // sensitivity_class 必填，必须在合法集合内
  if (
    typeof b.sensitivity_class !== "string" ||
    !VALID_SENSITIVITY_CLASSES.has(b.sensitivity_class)
  ) {
    return [false, `sensitivity_class 必须是 ${SENSITIVITY_CLASSES.join(" / ")} 之一`, null];
  }

  // rationale_code 必填，非空字符串（§13 API 规范）
  if (typeof b.rationale_code !== "string" || b.rationale_code.length === 0) {
    return [false, "rationale_code 必填且非空", null];
  }
  if (b.rationale_code.length > 64) {
    return [false, "rationale_code 超过最大长度 64", null];
  }

  return [true, "", body as MemoryCandidateBody];
}

/** 从 GatewayPrincipal 构造 WorkloadPrincipal。 */
function toWorkloadPrincipal(principal: GatewayPrincipal): WorkloadPrincipal {
  return {
    tenantId: principal.tenantId,
    audience: principal.audience,
    callerType: "workload",
    claims: principal,
    serviceId: principal.serviceId ?? null,
    invocationId: principal.invocationId,
    runtimeRevisionId: principal.runtimeRevisionId ?? null,
  };
}

/** 把 Candidate 行投影为 API 响应体（snake_case；rejected 不回显内容）。 */
function projectCandidate(candidate: {
  id: string;
  candidateState: string;
  resolvedMemoryEntryId: string | null;
  decisionReasonCodesJson: string[] | null;
  proposedAt: Date;
  resolvedAt: Date | null;
  proposedScopeType: string;
  proposedScopeRef: string | null;
}): {
  candidate_id: string;
  candidate_state: string;
  memory_entry_id: string | null;
  decision_reason_codes: string[] | null;
  proposed_scope: { type: string; ref: string | null };
  proposed_at: string;
  resolved_at: string | null;
} {
  return {
    candidate_id: candidate.id,
    candidate_state: candidate.candidateState,
    memory_entry_id: candidate.resolvedMemoryEntryId,
    decision_reason_codes: candidate.decisionReasonCodesJson,
    proposed_scope: {
      type: candidate.proposedScopeType,
      ref: candidate.proposedScopeRef,
    },
    proposed_at: candidate.proposedAt.toISOString(),
    resolved_at: candidate.resolvedAt ? candidate.resolvedAt.toISOString() : null,
  };
}

/**
 * POST /gateway/v1/memory-candidates handler。
 */
export async function memoryCandidatePOST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 Gateway 身份
  let principal: GatewayPrincipal;
  try {
    principal = await resolveGatewayPrincipal(request.headers);
  } catch (error) {
    const authResponse = gatewayAuthErrorResponse(error, requestId);
    return authResponse ?? apiError("AUTHENTICATION_REQUIRED", "身份解析失败", { requestId });
  }

  // 2. 校验 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (!idempotencyKey || idempotencyKey.trim().length === 0) {
    return gatewaySchemaInvalidTable(requestId, "Idempotency-Key 头必填");
  }

  // 3. 解析请求体
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return gatewaySchemaInvalidTable(requestId, "请求体必须是合法 JSON");
  }

  // 4. 校验请求体
  const [valid, errorMessage, parsed] = validateBody(body, principal.invocationId);
  if (!valid || !parsed) {
    return gatewaySchemaInvalidTable(requestId, errorMessage);
  }

  // 5. 校验 content_hash 与 content.text 一致（若 text 提供）
  if (parsed.content.text) {
    if (!verifyMemoryContentHash(parsed.content.text, parsed.content_hash)) {
      return apiError("MEMORY_CONTENT_HASH_MISMATCH", "content_hash 与 content.text 不一致", {
        requestId,
      });
    }
  }

  // 6. 计算候选 key
  const { sourceType, sourceId } = deriveSourceFromCandidate({
    sourceItemId: parsed.source.item_id,
    sourceJobId: parsed.source.job_id,
    sourceArtifactId: parsed.source.artifact_id,
  });
  const candidateKey = computeCandidateKey({
    invocationId: principal.invocationId,
    sourceType,
    sourceId,
    contentHash: parsed.content_hash,
    scopeType: parsed.proposed_scope.type as MemoryScopeType,
    scopeRef: parsed.proposed_scope.ref ?? null,
  });

  // 7. 幂等守卫
  const path = "/gateway/v1/memory-candidates";
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromWorkloadPrincipal(toWorkloadPrincipal(principal));
  const commandScope = "memory.candidate.create";

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 8. 幂等重放 / 冲突处理
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

  // 9. retry_allowed：重置 failed 记录后重试
  let recordId: string;
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
  } else {
    recordId = outcome.record.id;
  }

  // 10. 执行业务：创建 Memory Candidate
  try {
    // 检查是否已有相同 candidate_key 的 Candidate（去重）
    const existing = await findMemoryCandidateByCandidateKey(principal.tenantId, candidateKey);

    let candidate: MemoryCandidate;
    if (existing) {
      // 已存在相同 Candidate，直接返回（去重）
      candidate = existing;
    } else {
      // 评估 Memory Policy
      const policyDecision = evaluateMemoryPolicy({
        contentRedacted: parsed.content.text ?? null,
        proposedScopeType: parsed.proposed_scope.type as MemoryScopeType,
        sensitivityClass: parsed.sensitivity_class as SensitivityClass,
      });

      // sourceHash：来源事实自身 hash；若 Runtime 未提供则回落到 content_hash（来源内容即记忆内容）
      const sourceHash = parsed.source.hash ?? parsed.content_hash;
      const rationaleCode = parsed.rationale_code;

      if (policyDecision.decision === "accepted") {
        // accepted：同事务写 candidate + entry + source
        const result = await createMemoryCandidateWithEntry({
          tenantId: principal.tenantId,
          invocationId: principal.invocationId,
          sourceThreadId: parsed.source.thread_id ?? null,
          sourceTurnId: parsed.source.turn_id ?? null,
          sourceItemId: parsed.source.item_id ?? null,
          sourceJobId: parsed.source.job_id ?? null,
          sourceArtifactId: parsed.source.artifact_id ?? null,
          proposedScopeType: parsed.proposed_scope.type as MemoryScopeType,
          proposedScopeRef: parsed.proposed_scope.ref ?? null,
          memoryType: parsed.memory_type,
          contentRef: parsed.content.content_ref ?? null,
          contentRedacted: parsed.content.text ?? null,
          contentHash: parsed.content_hash,
          candidateKey,
          sensitivityClass: parsed.sensitivity_class as SensitivityClass,
          decisionReasonCodesJson:
            policyDecision.reasonCodes.length > 0 ? policyDecision.reasonCodes : null,
          sourceHash,
          rationaleCode,
        });
        candidate = result.candidate;
      } else if (policyDecision.decision === "rejected") {
        // rejected：销毁正文，不创建 entry
        candidate = await insertMemoryCandidate({
          tenantId: principal.tenantId,
          invocationId: principal.invocationId,
          sourceThreadId: parsed.source.thread_id ?? null,
          sourceTurnId: parsed.source.turn_id ?? null,
          sourceItemId: parsed.source.item_id ?? null,
          sourceJobId: parsed.source.job_id ?? null,
          sourceArtifactId: parsed.source.artifact_id ?? null,
          proposedScopeType: parsed.proposed_scope.type as MemoryScopeType,
          proposedScopeRef: parsed.proposed_scope.ref ?? null,
          memoryType: parsed.memory_type,
          contentRef: parsed.content.content_ref ?? null,
          contentRedacted: parsed.content.text ?? null,
          contentHash: parsed.content_hash,
          candidateKey,
          sensitivityClass: parsed.sensitivity_class as SensitivityClass,
          candidateState: "rejected",
          decisionReasonCodesJson: policyDecision.reasonCodes,
          sourceHash,
          rationaleCode,
        });
      } else {
        // needs_review：等待管理员复核
        candidate = await insertMemoryCandidate({
          tenantId: principal.tenantId,
          invocationId: principal.invocationId,
          sourceThreadId: parsed.source.thread_id ?? null,
          sourceTurnId: parsed.source.turn_id ?? null,
          sourceItemId: parsed.source.item_id ?? null,
          sourceJobId: parsed.source.job_id ?? null,
          sourceArtifactId: parsed.source.artifact_id ?? null,
          proposedScopeType: parsed.proposed_scope.type as MemoryScopeType,
          proposedScopeRef: parsed.proposed_scope.ref ?? null,
          memoryType: parsed.memory_type,
          contentRef: parsed.content.content_ref ?? null,
          contentRedacted: parsed.content.text ?? null,
          contentHash: parsed.content_hash,
          candidateKey,
          sensitivityClass: parsed.sensitivity_class as SensitivityClass,
          candidateState: "needs_review",
          decisionReasonCodesJson: policyDecision.reasonCodes,
          sourceHash,
          rationaleCode,
        });
      }
    }

    // 11. completeRecord + 返回 201
    const responseBody = projectCandidate(candidate);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRef: candidate.id,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 201,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);
    throw err;
  }
}
