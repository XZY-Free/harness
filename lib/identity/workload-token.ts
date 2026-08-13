/**
 * Workload / Service Identity 模型。
 *
 * 四类 API 受众的身份来源（11-api-and-event-boundaries.md 、§9）：
 * - employee：员工 SSO Session + 可选 Desktop 设备签名。
 * - runtime：短期 Workload Identity，绑定 tenant/invocation/runtime_revision/audience/TTL。
 * - gateway：Invocation-scoped Workload Identity，只能访问 ExecutionBinding 允许的资源。
 * - admin：管理员 SSO + RBAC；CI/CD 使用受限 Service Identity。
 *
 * Token 设计（11-api-and-event-boundaries.md ）：
 * - Runtime/Gateway Token 绑定 tenant、invocation、runtime_revision、允许的 audience 和短有效期。
 * - Token 编码为平台自有格式（base64url(JSON)），非 JWT——签名由网关 / Invocation Dispatcher
 * 在颁发时完成，应用层只验证 claims，不做签名验证（颁发接口在阶段 5 实现）。
 * - 当前阶段（S02-C02）只建立数据结构与解析；实际颁发由阶段 5 Invocation Dispatcher 实现。
 *
 * 安全边界：
 * - 模型伪造 userId → 服务端忽略并使用 Workload/Session 身份（阶段 2 验收）。
 * - CI/CD Service Identity 只得到制品验证和发布所需动作，不获得员工会话权限。
 * - 撤销设备后拒绝新 Lease、Workspace handle 和迟到签名请求。
 *
 * 事实源：docs/architecture/api-and-events.md 、§9、
 * docs/architecture/security.md §5。
 */
import { randomUUID } from "node:crypto";
import { API_STATUS, apiError, generateRequestId } from "@/lib/http";
import type { ApiAudience } from "@/lib/http";

/** Workload Identity 类型（caller_type in idempotency_record）。 */
export type WorkloadCallerType = "user" | "device" | "workload" | "service";

/** Runtime / Gateway Token 的 claims（11-api-and-event-boundaries.md ）。 */
export interface WorkloadTokenClaims {
 /** Token 类型：runtime（Runtime Protocol）/ gateway（Gateway API）/ service（CI/CD Service Identity）。 */
 type: "runtime" | "gateway" | "service";
 /** 绑定租户 id（从身份解析，不信任模型 JSON 参数）。 */
 tenantId: string;
 /** Token 唯一 id（S12-W05）：用于撤销与重放保护；颁发时生成 randomUUID。 */
 jti: string;
 /** 绑定 Invocation id；Runtime/Gateway Token 必须等于当前 path 的 invocation_id。 */
 invocationId?: string;
 /** Runtime 修订（仅 Runtime Protocol Token）。 */
 runtimeRevisionId?: string;
 /** 允许的 audience（与 idempotency_record.audience 对齐）。 */
 audience: ApiAudience;
 /** Service Identity 标识（仅 type=service，如 "cicd"）。 */
 serviceId?: string;
 /** 颁发时间（Unix ms）。 */
 issuedAt: number;
 /** 过期时间（Unix ms）；短有效期。 */
 expiresAt: number;
}

/** Workload Token 解析错误（route 层应映射为 401 AUTHENTICATION_REQUIRED）。 */
export class WorkloadTokenError extends Error {
 constructor(
 public readonly code:
 | "missing_token"
 | "malformed_token"
 | "expired_token"
 | "audience_mismatch"
 | "invocation_mismatch"
 | "token_revoked"
 | "missing_jti",
 message: string,
 ) {
 super(message);
 }
}

/**
 * 解码 Workload Token（base64url(JSON)）。
 *
 * 仅解码与 claims 校验，不做签名验证——签名由网关 / Invocation Dispatcher 在颁发时完成，
 * 应用层假设 Token 来自可信颁发者（网络隔离保证）。
 *
 * 颁发接口在阶段 5 Invocation Dispatcher 实现；本函数供 route handler 解析 Authorization header。
 */
export function decodeWorkloadToken(token: string): WorkloadTokenClaims {
 let payload: unknown;
 try {
 const json = Buffer.from(token, "base64url").toString("utf-8");
 payload = JSON.parse(json);
 } catch {
 throw new WorkloadTokenError("malformed_token", "Workload Token 格式非法");
 }

 if (!payload || typeof payload !== "object") {
 throw new WorkloadTokenError("malformed_token", "Workload Token 内容非对象");
 }

 const claims = payload as Partial<WorkloadTokenClaims>;
 if (claims.type !== "runtime" && claims.type !== "gateway" && claims.type !== "service") {
 throw new WorkloadTokenError("malformed_token", "Workload Token type 缺失或非法");
 }
 if (!claims.tenantId) {
 throw new WorkloadTokenError("malformed_token", "Workload Token 缺失 tenantId");
 }
 if (!claims.audience) {
 throw new WorkloadTokenError("malformed_token", "Workload Token 缺失 audience");
 }
 if (typeof claims.issuedAt !== "number" || typeof claims.expiresAt !== "number") {
 throw new WorkloadTokenError("malformed_token", "Workload Token 缺失 issuedAt/expiresAt");
 }

 // S12-W05：jti 必填（用于撤销与重放保护）
 if (!claims.jti || typeof claims.jti !== "string") {
 throw new WorkloadTokenError("missing_jti", "Workload Token 缺失 jti");
 }

 // 过期校验
 const now = Date.now();
 if (now >= claims.expiresAt) {
 throw new WorkloadTokenError("expired_token", "Workload Token 已过期");
 }

 // type=service 必须有 serviceId
 if (claims.type === "service" && !claims.serviceId) {
 throw new WorkloadTokenError("malformed_token", "Service Identity Token 缺失 serviceId");
 }

 // type=runtime/gateway 必须有 invocationId
 if ((claims.type === "runtime" || claims.type === "gateway") && !claims.invocationId) {
 throw new WorkloadTokenError("malformed_token", `${claims.type} Token 缺失 invocationId`);
 }

 // type=runtime 必须有 runtimeRevisionId
 if (claims.type === "runtime" && !claims.runtimeRevisionId) {
 throw new WorkloadTokenError("malformed_token", "Runtime Token 缺失 runtimeRevisionId");
 }

 return claims as WorkloadTokenClaims;
}

/**
 * 从 Authorization header 提取 Bearer token。
 * 非 Bearer 或空返回 null（调用方据此判断是否走 Workload 认证）。
 */
export function extractBearerToken(headers: Headers): string | null {
 const auth = headers.get("authorization");
 if (!auth) return null;
 const match = auth.match(/^Bearer\s+(.+)$/i);
 return match?.[1]?.trim() ?? null;
}

/**
 * 校验 Workload Token 的 audience 与请求期望 audience 一致。
 * Token audience 必须等于期望 audience（runtime Token 不能用于 gateway API）。
 */
export function assertAudienceMatch(claims: WorkloadTokenClaims, expected: ApiAudience): void {
 if (claims.audience !== expected) {
 throw new WorkloadTokenError(
 "audience_mismatch",
 `Token audience=${claims.audience} 与请求期望 audience=${expected} 不匹配`,
 );
 }
}

/**
 * 校验 Runtime/Gateway Token 的 invocationId 与请求 path 的 invocationId 一致。
 * Runtime Token 不能用于其他 Invocation 的 API（11-api-and-event-boundaries.md ）。
 */
export function assertInvocationMatch(
 claims: WorkloadTokenClaims,
 expectedInvocationId: string,
): void {
 if (claims.invocationId !== expectedInvocationId) {
 throw new WorkloadTokenError(
 "invocation_mismatch",
 `Token invocationId=${claims.invocationId} 与请求期望=${expectedInvocationId} 不匹配`,
 );
 }
}

/**
 * 把 WorkloadTokenError 转成 401 响应；非 Token 错误返回 null。
 * `requestId` 来自路由入口的 getRequestId(request)，保证可跟踪。
 */
export function workloadTokenErrorResponse(
 error: unknown,
 requestId: string = generateRequestId(),
): Response | null {
 if (error instanceof WorkloadTokenError) {
 return apiError("AUTHENTICATION_REQUIRED", error.message, { requestId });
 }
 return null;
}

/**
 * 颁发 Workload Token（base64url(JSON)）。
 *
 * 仅供阶段 5 Invocation Dispatcher 在创建 Invocation 时内部调用；
 * 当前阶段（S02-C02）导出供测试与后续阶段使用，route handler 不应调用。
 *
 * S12-W05：自动生成 jti（randomUUID）用于撤销与重放保护；调用方可覆盖 jti。
 *
 * 生产环境签名由网关 / Invocation Dispatcher 在颁发时完成；本函数只编码 claims，
 * 不做签名——应用层假设 Token 来自可信颁发者（网络隔离保证）。
 */
export function issueWorkloadToken(
 claims: Omit<WorkloadTokenClaims, "issuedAt" | "jti"> & { jti?: string },
): string {
 const now = Date.now();
 const full: WorkloadTokenClaims = {
 ...claims,
 jti: claims.jti ?? randomUUID(),
 issuedAt: now,
 };
 const json = JSON.stringify(full);
 return Buffer.from(json, "utf-8").toString("base64url");
}

/** 默认 Token TTL（ms）：Runtime/Gateway 5min，Service 10min。 */
export const WORKLOAD_TOKEN_DEFAULT_TTL_MS = {
 runtime: 5 * 60 * 1000,
 gateway: 5 * 60 * 1000,
 service: 10 * 60 * 1000,
} as const;

/**
 * CI/CD Service Identity 的默认允许动作（14-production-operations-security-and-retention.md §4、§5）。
 * Service Identity 只能提交引用，不能自报 verification_state；不能发布 Revision。
 *
 * 动作码必须与 action-codes.ts 的稳定 ACTION_CODES 目录对齐：
 * - agent.revision.create（不是 agent.revision.draft）— 与方案 稳定管理动作列表一致。
 */
export const CICD_SERVICE_ALLOWED_ACTIONS = [
 "artifact.attestation.verify",
 "agent.revision.create",
 "deletion.request",
] as const;

/** 校验 Service Identity 是否允许执行指定 action code。 */
export function isServiceActionAllowed(serviceId: string, actionCode: string): boolean {
 // 当前阶段只有 cicd service；后续扩展其他 service 时在此分支。
 if (serviceId !== "cicd") {
 return false;
 }
 return (CICD_SERVICE_ALLOWED_ACTIONS as readonly string[]).includes(actionCode);
}

/** API_STATUS 重新导出，供 route handler 便捷引用。 */
export { API_STATUS };
