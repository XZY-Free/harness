import {
  computeSourceRangesHash,
  createContextCheckpoint,
  findContextCheckpointByUniqueKey,
  isValidSummaryHash,
} from "@/lib/context/checkpoint-queries";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
/**
 * POST /gateway/v1/context-checkpoints — 提交 Context Checkpoint（阶段 7 S07-C02）。
 *
 * 事实源：
 * - docs/architecture/context-memory-and-knowledge.md §6（压缩）、§7（Trace）、§15（失败与恢复）。
 * - docs/architecture/persistence.md §7.5（context_checkpoint 表）。
 * - docs/architecture/memory-and-job-api.md §3（Context Checkpoint API）。
 * - docs/architecture/context-memory-and-knowledge.md S07-W03。
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=gateway，绑定 invocation）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（checkpoint_type / source_ranges / summary / summary_hash / token_accounting）。
 * - invocationId 来自 Token claims，不信任请求体（请求体的 invocation_id 仅用于校验一致性）。
 * - 写入 ContextCheckpoint + 幂等记录（同事务）。
 * - 返回 201 + checkpoint 投影。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - 请求体 invocation_id 与 Token invocationId 不一致 → 400 REQUEST_SCHEMA_INVALID
 * - summary_ref 与 summary_redacted 都为空 → 400 REQUEST_SCHEMA_INVALID
 * - source_ranges 或 summary 过大 → 413 CONTEXT_CHECKPOINT_TOO_LARGE
 * - 来源范围 hash 不一致 → 409 CONTEXT_SOURCE_HASH_MISMATCH
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 *
 * 边界：
 * - Checkpoint 不删除原始 Item/Event，不写 Memory，不保存 Credential/隐藏思维链。
 * - summary_redacted 存脱敏摘要；不含隐藏思维链。
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
  CHECKPOINT_TYPES,
  type CheckpointType,
  type ContextCheckpoint,
  type SourceRange,
} from "@/lib/persistence/schema/context-checkpoint";

export const dynamic = "force-dynamic";

/** 摘要/来源大小限制（防止 413）。 */
const MAX_SUMMARY_REDACTED_LENGTH = 100_000;
const MAX_SOURCE_RANGES_COUNT = 200;
const MAX_SUMMARY_REF_LENGTH = 512;

/** 合法 source range type 集合。 */
const VALID_RANGE_TYPES: ReadonlySet<string> = new Set([
  "thread_item",
  "thread_event",
  "memory",
  "knowledge",
]);

/** 请求体 schema。 */
interface ContextCheckpointBody {
  invocation_id: string;
  checkpoint_type: string;
  source_ranges: unknown[];
  summary: {
    text?: string;
    content_ref?: string;
  };
  summary_hash: string;
  token_accounting: {
    input: number;
    retained: number;
    compressed: number;
  };
}

/** 校验请求体结构。返回 [valid, errorMessage]。 */
function validateBody(
  body: unknown,
  tokenInvocationId: string,
): [boolean, string, ContextCheckpointBody | null] {
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

  // checkpoint_type 必填，必须在合法集合内
  if (
    typeof b.checkpoint_type !== "string" ||
    !(CHECKPOINT_TYPES as readonly string[]).includes(b.checkpoint_type)
  ) {
    return [false, `checkpoint_type 必须是 ${CHECKPOINT_TYPES.join(" / ")} 之一`, null];
  }

  // source_ranges 必填，非空数组
  if (!Array.isArray(b.source_ranges) || b.source_ranges.length === 0) {
    return [false, "source_ranges 必填且为非空数组", null];
  }
  if (b.source_ranges.length > MAX_SOURCE_RANGES_COUNT) {
    return [false, `source_ranges 超过最大数量 ${MAX_SOURCE_RANGES_COUNT}`, null];
  }

  // 校验每个 source_range
  for (const range of b.source_ranges) {
    if (!range || typeof range !== "object") {
      return [false, "source_ranges 中每个元素必须是对象", null];
    }
    const r = range as Record<string, unknown>;
    if (typeof r.type !== "string" || !VALID_RANGE_TYPES.has(r.type)) {
      return [false, `source_range.type 必须是 ${[...VALID_RANGE_TYPES].join(" / ")} 之一`, null];
    }
    if (typeof r.range_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(r.range_hash)) {
      return [false, "source_range.range_hash 必须是 sha256:<64 hex> 格式", null];
    }
    if (r.from_sequence !== undefined && r.from_sequence !== null) {
      if (
        typeof r.from_sequence !== "number" ||
        !Number.isInteger(r.from_sequence) ||
        r.from_sequence < 0
      ) {
        return [false, "source_range.from_sequence 必须是非负整数", null];
      }
    }
    if (r.to_sequence !== undefined && r.to_sequence !== null) {
      if (
        typeof r.to_sequence !== "number" ||
        !Number.isInteger(r.to_sequence) ||
        r.to_sequence < 0
      ) {
        return [false, "source_range.to_sequence 必须是非负整数", null];
      }
    }
    if (r.resource_ids !== undefined && r.resource_ids !== null) {
      if (!Array.isArray(r.resource_ids) || !r.resource_ids.every((id) => typeof id === "string")) {
        return [false, "source_range.resource_ids 必须是字符串数组", null];
      }
    }
  }

  // summary 必填，对象
  if (!b.summary || typeof b.summary !== "object") {
    return [false, "summary 必填且为对象", null];
  }
  const summary = b.summary as Record<string, unknown>;
  if (typeof summary.text !== "string" && typeof summary.content_ref !== "string") {
    return [false, "summary.text 与 summary.content_ref 至少一个非空", null];
  }
  if (summary.text !== undefined) {
    if (typeof summary.text !== "string") {
      return [false, "summary.text 必须是字符串", null];
    }
    if (summary.text.length > MAX_SUMMARY_REDACTED_LENGTH) {
      return [false, `summary.text 超过最大长度 ${MAX_SUMMARY_REDACTED_LENGTH}`, null];
    }
  }
  if (summary.content_ref !== undefined) {
    if (typeof summary.content_ref !== "string" || summary.content_ref.length === 0) {
      return [false, "summary.content_ref 必须是非空字符串", null];
    }
    if (summary.content_ref.length > MAX_SUMMARY_REF_LENGTH) {
      return [false, `summary.content_ref 超过最大长度 ${MAX_SUMMARY_REF_LENGTH}`, null];
    }
  }

  // summary_hash 必填，sha256: 前缀 + 64 hex
  if (typeof b.summary_hash !== "string" || !isValidSummaryHash(b.summary_hash)) {
    return [false, "summary_hash 必须是 sha256:<64 hex> 格式", null];
  }

  // token_accounting 必填，对象
  if (!b.token_accounting || typeof b.token_accounting !== "object") {
    return [false, "token_accounting 必填且为对象", null];
  }
  const ta = b.token_accounting as Record<string, unknown>;
  if (typeof ta.input !== "number" || !Number.isInteger(ta.input) || ta.input < 0) {
    return [false, "token_accounting.input 必须是非负整数", null];
  }
  if (typeof ta.retained !== "number" || !Number.isInteger(ta.retained) || ta.retained < 0) {
    return [false, "token_accounting.retained 必须是非负整数", null];
  }
  if (typeof ta.compressed !== "number" || !Number.isInteger(ta.compressed) || ta.compressed < 0) {
    return [false, "token_accounting.compressed 必须是非负整数", null];
  }

  return [true, "", body as ContextCheckpointBody];
}

/** 把 source_ranges 原始数组转为强类型 SourceRange[]。 */
function parseSourceRanges(raw: unknown[]): SourceRange[] {
  return raw.map((r) => {
    const range = r as Record<string, unknown>;
    return {
      type: range.type as SourceRange["type"],
      fromSequence: typeof range.from_sequence === "number" ? range.from_sequence : null,
      toSequence: typeof range.to_sequence === "number" ? range.to_sequence : null,
      resourceIds: Array.isArray(range.resource_ids) ? (range.resource_ids as string[]) : undefined,
      rangeHash: range.range_hash as string,
    } satisfies SourceRange;
  });
}

/** 从 GatewayPrincipal 构造 WorkloadPrincipal（供 callerFromWorkloadPrincipal 使用）。 */
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

/**
 * POST /gateway/v1/context-checkpoints handler。
 */
export async function contextCheckpointPOST(request: Request): Promise<Response> {
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

  // 5. 幂等守卫
  const path = "/gateway/v1/context-checkpoints";
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromWorkloadPrincipal(toWorkloadPrincipal(principal));
  const commandScope = "context.checkpoint.create";

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 6. 幂等重放 / 冲突处理
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

  // 7. retry_allowed：重置 failed 记录后重试
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

  // 8. 执行业务：创建 Context Checkpoint
  try {
    const sourceRanges = parseSourceRanges(parsed.source_ranges);

    // 检查是否已有相同 (invocation, type, ranges) 的 Checkpoint（幂等去重）
    const existing = await findContextCheckpointByUniqueKey({
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
      checkpointType: parsed.checkpoint_type as CheckpointType,
      sourceRanges,
    });

    let checkpoint: ContextCheckpoint;
    if (existing) {
      // 已存在相同 Checkpoint，直接返回（幂等去重）
      checkpoint = existing;
    } else {
      checkpoint = await createContextCheckpoint({
        tenantId: principal.tenantId,
        invocationId: principal.invocationId,
        checkpointType: parsed.checkpoint_type as CheckpointType,
        sourceRanges,
        summaryRef: parsed.summary.content_ref ?? null,
        summaryRedacted: parsed.summary.text ?? null,
        summaryHash: parsed.summary_hash,
        tokenAccounting: parsed.token_accounting,
      });
    }

    // 9. completeRecord + 返回 201
    const responseBody = projectCheckpoint(checkpoint);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRef: checkpoint.id,
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

/** 把 ContextCheckpoint 行投影为 API 响应体。 */
function projectCheckpoint(checkpoint: {
  id: string;
  invocationId: string;
  checkpointType: string;
  summaryHash: string;
  createdAt: Date;
}): {
  checkpoint_id: string;
  invocation_id: string;
  checkpoint_type: string;
  summary_hash: string;
  created_at: string;
} {
  return {
    checkpoint_id: checkpoint.id,
    invocation_id: checkpoint.invocationId,
    checkpoint_type: checkpoint.checkpointType,
    summary_hash: checkpoint.summaryHash,
    created_at: checkpoint.createdAt.toISOString(),
  };
}
