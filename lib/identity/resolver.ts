/**
 * 身份解析器。
 *
 * 从请求 header 解析可信身份 → 映射到租户内稳定 userIdentity → 返回 Principal。
 *
 * 安全边界：
 * - dev 模式仅由明确的开发配置启用，返回默认身份。
 * - trusted-headers 模式从网关注入的 header 解析，应用层不做来源校验
 * （靠网络隔离 K8s NetworkPolicy / 防火墙保证仅网关能达 pod）。
 * - 生产环境缺少可信身份直接 401 AUTHENTICATION_REQUIRED。
 *
 * audience=runtime/gateway/admin 的 Workload Token 验证见 resolveWorkloadPrincipal。
 */
import { authConfig } from "@/lib/config";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { type ApiAudience, apiError, generateRequestId } from "@/lib/http";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
 type WorkloadCallerType,
 type WorkloadTokenClaims,
 assertAudienceMatch,
 decodeWorkloadToken,
 extractBearerToken,
} from "@/lib/identity/workload-token";

/** 可信主体：四类 API 共用的身份信息。 */
export interface Principal {
 tenantId: string;
 tenantKey: string;
 userIdentityId: string;
 externalSubject: string;
 email: string;
 displayName: string | null;
 audience: ApiAudience;
}

/** 认证失败错误（route 层应映射为 401 AUTHENTICATION_REQUIRED）。 */
export class AuthenticationError extends Error {
 constructor(
 public readonly code: "missing_identity" | "missing_email" | "tenant_suspended",
 message: string,
 ) {
 super(message);
 }
}

/**
 * 把 AuthenticationError 转成 401 响应；非认证错误返回 null。
 * `requestId` 来自路由入口的 getRequestId(request)，保证可跟踪。
 */
export function authErrorResponse(
 error: unknown,
 requestId: string = generateRequestId(),
): Response | null {
 if (error instanceof AuthenticationError) {
 return apiError("AUTHENTICATION_REQUIRED", error.message, { requestId });
 }
 return null;
}

function headerValue(headers: Headers, name: string): string | null {
 const value = headers.get(name);
 return value?.trim() ? value.trim() : null;
}

/** 从 header 解析原始身份（dev 或 trusted-headers）。 */
function resolveRawIdentity(headers: Headers): {
 externalSubject: string;
 email: string;
 displayName: string | null;
} {
 if (authConfig.mode === "dev") {
 return {
 externalSubject: DEFAULT_USER_ID,
 email: DEFAULT_USER_EMAIL,
 displayName: DEFAULT_USER_NAME,
 };
 }

 const externalSubject = headerValue(headers, authConfig.externalIdHeader);
 const email = headerValue(headers, authConfig.emailHeader);
 const displayName = headerValue(headers, authConfig.nameHeader);

 if (!externalSubject) {
 throw new AuthenticationError("missing_identity", "缺少 SSO 用户标识");
 }
 if (!email) {
 throw new AuthenticationError("missing_email", "缺少 SSO 用户邮箱");
 }

 return { externalSubject, email, displayName };
}

/**
 * 从请求解析 可信主体（HTTP route 入口用）。
 *
 * 流程：ensureDefaultTenant → resolveRawIdentity → upsertUserIdentity → upsertPrincipalBinding。
 * 返回的 Principal 包含 tenantId 和 userIdentityId，供后续授权和业务使用。
 */
export async function resolvePrincipal(
 headers: Headers,
 audience: ApiAudience = "employee",
): Promise<Principal> {
 const tenant = await ensureDefaultTenant();
 if (tenant.status !== "active") {
 throw new AuthenticationError("tenant_suspended", "租户已被暂停");
 }

 const { externalSubject, email, displayName } = resolveRawIdentity(headers);

 const identity = await upsertUserIdentity({
 tenantId: tenant.id,
 externalSubject,
 email,
 displayName,
 });

 // 同步 principal_binding（subjectType=user），保证外部 subject 到内部 identity 的映射可查。
 await upsertPrincipalBinding({
 tenantId: tenant.id,
 subjectType: "user",
 externalId: externalSubject,
 displayName,
 userIdentityId: identity.id,
 });

 return {
 tenantId: tenant.id,
 tenantKey: tenant.key,
 userIdentityId: identity.id,
 externalSubject,
 email,
 displayName,
 audience,
 };
}

/**
 * 无 Request 上下文时解析 主体（仅 dev 模式可用）。
 * trusted-headers 模式下因无 header 会抛 AuthenticationError。
 */
export async function getCurrentPrincipal(audience: ApiAudience = "employee"): Promise<Principal> {
 return resolvePrincipal(new Headers(), audience);
}

// ─── Workload / Service Identity（S02-C02）─────────────────────

/**
 * Workload 主体：runtime/gateway/admin audience 的可信身份。
 *
 * 与 Principal 的区别：
 * - 不映射到 userIdentity（Runtime/Gateway/Service 无员工身份）。
 * - 携带 WorkloadTokenClaims，供后续 Invocation 校验与幂等账本 caller_type 使用。
 * - callerType 标识身份类型，写入 idempotency_record.caller_type。
 */
export interface WorkloadPrincipal {
 tenantId: string;
 audience: ApiAudience;
 callerType: WorkloadCallerType;
 /** Workload Token claims（含 invocationId/runtimeRevisionId/serviceId/expiresAt）。 */
 claims: WorkloadTokenClaims;
 /** Service Identity 标识（仅 callerType=service）；其他类型为 null。 */
 serviceId: string | null;
 /** 绑定 Invocation id（runtime/gateway Token 必填）；service 为 null。 */
 invocationId: string | null;
 /** Runtime 修订（仅 runtime Token）；gateway/service 为 null。 */
 runtimeRevisionId: string | null;
}

/**
 * 从 Authorization header 解析 Workload 主体（runtime/gateway/admin audience 用）。
 *
 * 流程：
 * 1. extractBearerToken：提取 Bearer token；缺失抛 AuthenticationError missing_identity。
 * 2. decodeWorkloadToken：解码 claims + 过期校验；格式非法抛 WorkloadTokenError。
 * 3. assertAudienceMatch：校验 Token audience 与请求期望 audience 一致。
 *
 * 不做租户 seed（Workload Token 已含 tenantId，由颁发方保证）。
 * 不映射 userIdentity（Runtime/Gateway/Service 无员工身份）。
 *
 * @param headers 请求 header
 * @param expectedAudience 请求期望的 audience（runtime/gateway/admin）
 * @throws AuthenticationError 缺少 token
 * @throws WorkloadTokenError Token 解析/过期/audience 不匹配
 */
export function resolveWorkloadPrincipal(
 headers: Headers,
 expectedAudience: "runtime" | "gateway" | "admin",
): WorkloadPrincipal {
 const token = extractBearerToken(headers);
 if (!token) {
 throw new AuthenticationError("missing_identity", `缺少 ${expectedAudience} Workload Token`);
 }

 const claims = decodeWorkloadToken(token);
 assertAudienceMatch(claims, expectedAudience);

 const callerType: WorkloadCallerType = claims.type === "service" ? "service" : "workload";

 return {
 tenantId: claims.tenantId,
 audience: claims.audience,
 callerType,
 claims,
 serviceId: claims.serviceId ?? null,
 invocationId: claims.invocationId ?? null,
 runtimeRevisionId: claims.runtimeRevisionId ?? null,
 };
}
