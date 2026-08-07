/**
 * 命令幂等守卫。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md 、
 * ../v11-agentkit-platform/11-api-and-event-boundaries.md 、
 * ../v11-agentkit-platform-development-plan/02-identity-authorization-and-common-ledgers.md 。
 *
 * 行为：
 * - 创建和命令 POST 在执行业务前登记 caller/audience/scope/key/request_hash。
 * - 同 key 同 request_hash 重放：completed → 返回原状态码与原资源引用；processing → 返回 in_flight（409，不重放）。
 * - 同 key 不同 request_hash：返回稳定 409 IDEMPOTENCY_CONFLICT。
 * - failed 记录：允许同 key 重试（resetFailedForRetry 后重新执行业务）。
 * - processing 超时可诊断（in_flight 返回 record_id 供排障），不允许简单再执行可能产生副作用的命令。
 *
 * 事务边界：幂等记录与首个业务写入同事务（route 层在 enforceIdempotency 返回 new 后，
 * 在同一事务内完成业务写入并调 completeIdempotencyRecord；本模块不强制事务，由调用方管理）。
 *
 * Tool 的 operation_id 由 ToolCall 单独负责，不是同一字段。
 */
import { createHash } from "node:crypto";
import type { ApiErrorCode } from "@/lib/error-codes";
import { apiError, generateRequestId } from "@/lib/http";
import type { ApiAudience } from "@/lib/http";
import {
 type IdempotencyUniqueKey,
 completeIdempotencyRecord,
 failIdempotencyRecord,
 findIdempotencyRecord,
 insertProcessingRecord,
 resetFailedForRetry,
} from "@/lib/identity/idempotency-queries";
import type { Principal, WorkloadPrincipal } from "@/lib/identity/resolver";
import type {
 IdempotencyCallerType,
 IdempotencyRecord,
} from "@/lib/persistence/schema/idempotency";

/** 幂等调用方（与 idempotency_record 唯一键对齐）。 */
export interface IdempotencyCaller {
 tenantId: string;
 audience: ApiAudience;
 callerType: IdempotencyCallerType;
 callerId: string;
}

/** enforceIdempotency 的结果：调用方据此决定执行业务 / 重放 / 返回冲突。 */
export type IdempotencyOutcome =
 | { kind: "new"; record: IdempotencyRecord }
 | { kind: "replay"; record: IdempotencyRecord }
 | { kind: "in_flight"; record: IdempotencyRecord }
 | { kind: "retry_allowed"; record: IdempotencyRecord }
 | { kind: "conflict"; existingRecord: IdempotencyRecord };

/**
 * 幂等守卫入口：在执行业务前调用。
 *
 * 流程：
 * 1. 查找同唯一键记录。
 * 2. 不存在 → INSERT processing 记录；并发冲突 → 重新查找走存在分支。
 * 3. 存在 + 同 requestHash：
 * - processing → in_flight（不重放，返回 409 供诊断）
 * - completed → replay（返回原状态码与响应）
 * - failed → retry_allowed（调用方 resetFailedForRetry 后重试）
 * 4. 存在 + 不同 requestHash → conflict（409 IDEMPOTENCY_CONFLICT）。
 *
 * @param caller 调用方身份
 * @param commandScope 规范化接口名 + 资源 Scope，如 `turn.create:thr_x`
 * @param idempotencyKey 调用方提供的幂等键（Idempotency-Key 头）
 * @param requestHash 规范化请求 sha256 hex（见 computeRequestHash）
 * @param expiresAt 过期时间；默认 24h
 */
export async function enforceIdempotency(params: {
 caller: IdempotencyCaller;
 commandScope: string;
 idempotencyKey: string;
 requestHash: string;
 expiresAt?: Date;
}): Promise<IdempotencyOutcome> {
 const { caller, commandScope, idempotencyKey, requestHash, expiresAt } = params;

 const key: IdempotencyUniqueKey = {
 tenantId: caller.tenantId,
 audience: caller.audience,
 callerType: caller.callerType,
 callerId: caller.callerId,
 commandScope,
 idempotencyKey,
 };

 const existing = await findIdempotencyRecord(key);

 if (!existing) {
 // 尝试插入新 processing 记录；并发同 key 时唯一约束冲突 → 重新查找。
 try {
 const record = await insertProcessingRecord({
 tenantId: caller.tenantId,
 audience: caller.audience,
 callerType: caller.callerType,
 callerId: caller.callerId,
 commandScope,
 idempotencyKey,
 requestHash,
 expiresAt,
 });
 return { kind: "new", record };
 } catch (err) {
 if (isDuplicateEntryError(err)) {
 const retried = await findIdempotencyRecord(key);
 if (retried) {
 return classifyExisting(retried, requestHash);
 }
 }
 throw err;
 }
 }

 return classifyExisting(existing, requestHash);
}

/** 对已存在记录分类（同 requestHash → replay/in_flight/retry_allowed；不同 → conflict）。 */
function classifyExisting(record: IdempotencyRecord, requestHash: string): IdempotencyOutcome {
 if (record.requestHash !== requestHash) {
 return { kind: "conflict", existingRecord: record };
 }
 switch (record.processingState) {
 case "processing":
 return { kind: "in_flight", record };
 case "completed":
 return { kind: "replay", record };
 case "failed":
 return { kind: "retry_allowed", record };
 }
}

/**
 * 重试路径：把 failed 记录重置为 processing（更新 requestHash / 清空响应字段）。
 * 调用方在 enforceIdempotency 返回 retry_allowed 后调用本函数，然后执行业务。
 * 非 failed 状态返回 null（调用方应返回 conflict/in_flight）。
 */
export async function prepareRetryForFailedRecord(params: {
 record: IdempotencyRecord;
 requestHash: string;
 expiresAt?: Date;
}): Promise<IdempotencyRecord | null> {
 if (params.record.processingState !== "failed") {
 return null;
 }
 const ok = await resetFailedForRetry({
 recordId: params.record.id,
 requestHash: params.requestHash,
 expiresAt: params.expiresAt,
 });
 if (!ok) return null;
 // 回查新状态
 const updated = await findIdempotencyRecord({
 tenantId: params.record.tenantId,
 audience: params.record.audience,
 callerType: params.record.callerType,
 callerId: params.record.callerId,
 commandScope: params.record.commandScope,
 idempotencyKey: params.record.idempotencyKey,
 });
 return updated ?? null;
}

/**
 * 完成幂等记录（业务成功后调用）。
 * 在与首个业务写入同一事务内提交。
 */
export async function completeRecord(params: {
 recordId: string;
 httpStatus: number;
 responseRef?: string | null;
 responseRedactedJson?: string | null;
}): Promise<void> {
 await completeIdempotencyRecord(params);
}

/** 标记幂等记录失败（业务异常时调用）。 */
export async function failRecord(recordId: string): Promise<void> {
 await failIdempotencyRecord(recordId);
}

/**
 * 计算规范化请求 hash（sha256 hex）。
 *
 * 规范化：
 * - body 为 object/array 时，按 key 递归排序后 JSON.stringify（保证字段顺序无关）。
 * - body 为 string/number/boolean/null 时，原样 JSON.stringify。
 * - 拼接 `${method}\n${path}\n${normalizedBody}` 后 sha256。
 *
 * 不同 method/path 即使 body 相同也产生不同 hash（避免跨接口重放）。
 */
export function computeRequestHash(method: string, path: string, body: unknown): string {
 const normalizedBody = JSON.stringify(sortKeys(body));
 const payload = `${method.toUpperCase()}\n${path}\n${normalizedBody}`;
 return createHash("sha256").update(payload, "utf-8").digest("hex");
}

/** 递归排序 object 的 key（数组保持顺序）。 */
function sortKeys(value: unknown): unknown {
 if (Array.isArray(value)) {
 return value.map(sortKeys);
 }
 if (value && typeof value === "object") {
 const sorted: Record<string, unknown> = {};
 for (const k of Object.keys(value as Record<string, unknown>).sort()) {
 sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
 }
 return sorted;
 }
 return value;
}

/** 从 Principal（员工 Session）提取幂等调用方。 */
export function callerFromPrincipal(principal: Principal): IdempotencyCaller {
 return {
 tenantId: principal.tenantId,
 audience: principal.audience,
 callerType: "user",
 callerId: principal.userIdentityId,
 };
}

/**
 * 从 WorkloadPrincipal（runtime/gateway/admin Service/Workload Token）提取幂等调用方。
 *
 * - service → callerId = serviceId
 * - workload（runtime/gateway）→ callerId = invocationId（Token 绑定 Invocation）
 *
 * @throws service 缺失 serviceId 或 runtime/gateway 缺失 invocationId 时抛错（调用方应先校验 Token）
 */
export function callerFromWorkloadPrincipal(principal: WorkloadPrincipal): IdempotencyCaller {
 if (principal.callerType === "service") {
 if (!principal.serviceId) {
 throw new Error("callerFromWorkloadPrincipal: service Token 缺失 serviceId");
 }
 return {
 tenantId: principal.tenantId,
 audience: principal.audience,
 callerType: "service",
 callerId: principal.serviceId,
 };
 }
 if (principal.callerType === "workload") {
 if (!principal.invocationId) {
 throw new Error("callerFromWorkloadPrincipal: runtime/gateway Token 缺失 invocationId");
 }
 return {
 tenantId: principal.tenantId,
 audience: principal.audience,
 callerType: "workload",
 callerId: principal.invocationId,
 };
 }
 // device callerType 当前不通过 WorkloadPrincipal 走幂等（Desktop 走 employee audience + 设备签名）
 throw new Error(
 `callerFromWorkloadPrincipal: 不支持的 callerType=${principal.callerType as string}`,
 );
}

/**
 * 构造重放响应：从 completed 记录恢复原 HTTP 状态码与响应体。
 *
 * - responseRedactedJson 必须包含可解析的完整响应；缺失或损坏时 fail-closed。
 * - record 非 completed 时抛错（调用方应先判断 outcome.kind）。
 */
export function buildReplayResponse(
 record: IdempotencyRecord,
 requestId?: string,
 validateBody?: (body: Record<string, unknown>) => boolean,
): Response {
 if (record.processingState !== "completed") {
 throw new Error(
 `buildReplayResponse: 记录非 completed（state=${record.processingState as string}）`,
 );
 }
 const status = record.httpStatus;
 if (status === null || !Number.isInteger(status) || status < 100 || status > 599) {
 throw new Error("buildReplayResponse: completed 记录 HTTP status 非法");
 }
 const rid = requestId ?? generateRequestId();
 const headers: Record<string, string> = { "x-request-id": rid };
 if (record.responseRef) {
 headers["x-idempotent-resource-ref"] = record.responseRef;
 }
 if (!record.responseRedactedJson) {
 throw new Error("buildReplayResponse: completed 记录缺失完整响应");
 }
 let body: unknown;
 try {
 body = JSON.parse(record.responseRedactedJson);
 } catch {
 throw new Error("buildReplayResponse: completed 记录响应损坏");
 }
 if (
 typeof body !== "object" ||
 body === null ||
 Array.isArray(body) ||
 Object.keys(body).length === 0
 ) {
 throw new Error("buildReplayResponse: completed 记录响应不是非空 JSON object");
 }
 if (validateBody && !validateBody(body as Record<string, unknown>)) {
 throw new Error("buildReplayResponse: completed 记录响应结构非法");
 }
 return Response.json(body, { status, headers });
}

/**
 * 构造幂等冲突响应（同 key 不同 request_hash，或 in_flight 诊断）。
 *
 * - reason="conflict"：同 key 不同 body，details 含 existing_request_hash。
 * - reason="in_flight"：同 key 同 body 但仍在处理，details 含 record_id + state。
 */
export function buildIdempotencyErrorResponse(params: {
 record: IdempotencyRecord;
 reason: "conflict" | "in_flight";
 requestId?: string;
}): Response {
 const rid = params.requestId ?? generateRequestId();
 const code: ApiErrorCode = "IDEMPOTENCY_CONFLICT";
 const message =
 params.reason === "conflict"
 ? "同 Idempotency-Key 对应不同请求体，拒绝重放"
 : "同 Idempotency-Key 的前一个请求仍在处理中，请稍后查询";
 const details: Record<string, unknown> = {
 idempotency_key: params.record.idempotencyKey,
 command_scope: params.record.commandScope,
 };
 if (params.reason === "conflict") {
 details.existing_request_hash = params.record.requestHash;
 } else {
 details.record_id = params.record.id;
 details.state = params.record.processingState;
 }
 return apiError(code, message, { requestId: rid, details });
}

/** 判断 MySQL 错误是否为唯一约束冲突（ER_DUP_ENTRY, code 1062）。 */
function isDuplicateEntryError(err: unknown): boolean {
 if (!err || typeof err !== "object") return false;
 const e = err as { code?: string; errno?: number };
 return e.code === "ER_DUP_ENTRY" || e.errno === 1062;
}
