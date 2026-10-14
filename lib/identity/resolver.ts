/**
 * 身份解析器（消费方薄壳）。
 *
 * nexharness 已不再是身份权威：用户 / 会话 / 企业资料全部由 auth-center 持有
 * （消费方模型，见 docs/split 施工图 v4）。本模块保留**历史签名**，内部改为
 * 经 `lib/identity-client` 调用 auth-center：
 *
 * - `resolvePrincipal(headers)` → 读取会话 token（cookie/Bearer）→ introspect
 *   （进程内缓存 30~60s）→ 映射为 Principal。
 * - 缺少/失效会话 → AuthenticationError（401 AUTHENTICATION_REQUIRED）。
 * - auth-center 不可达 → AuthCenterUnavailableError（fail-closed，routes 500）。
 *
 * runtime/gateway 执行凭据验证见 resolveWorkloadPrincipal（本地 workload token，
 * 不依赖 auth-center）。
 */
import { type ApiAudience, apiError, generateRequestId } from "@/lib/http";
import { introspectSession, readSessionToken } from "@/lib/identity-client";
import {
  type WorkloadTokenClaims,
  assertAudienceMatch,
  decodeWorkloadToken,
  extractBearerToken,
} from "@/lib/identity/workload-token";

export type WorkloadCallerType = "workload";

/** 企业资料属性（wire 形状；结构化读取由消费方自行按需解释）。 */
export type EnterpriseAttributes = Readonly<Record<string, unknown>>;

/** 可信主体：四类 API 共用的身份信息。 */
export interface Principal {
  tenantId: string;
  tenantKey: string;
  userIdentityId: string;
  externalSubject: string;
  email: string;
  displayName: string | null;
  audience: ApiAudience;
  /** 企业资料健康状态；default 模式为 unavailable，不影响标准身份使用。 */
  profileStatus?: EnterpriseUserProfileStatus;
  lastVerifiedAt?: Date | null;
  /** 服务端当前上下文使用的规范化企业字段，不包含 token/raw profile。 */
  enterpriseAttributes?: EnterpriseAttributes;
}

/** 当前用户上下文的强类型形式；普通 Principal 兼容保留为可选扩展。 */
export interface CurrentUserContext extends Principal {
  profileStatus: EnterpriseUserProfileStatus;
  lastVerifiedAt: Date | null;
  enterpriseAttributes: EnterpriseAttributes;
}

export type EnterpriseUserProfileStatus = "fresh" | "stale" | "unavailable" | "disabled";

/** 认证失败错误（route 层应映射为 401 AUTHENTICATION_REQUIRED）。 */
export class AuthenticationError extends Error {
  constructor(
    public readonly code:
      | "missing_identity"
      | "missing_email"
      | "authentication_denied"
      | "tenant_suspended"
      | "user_disabled",
    message: string,
  ) {
    super(message);
    this.name = "AuthenticationError";
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

/**
 * 从请求解析可信主体（HTTP route 入口用）。
 *
 * 流程：读取会话 token → auth-center introspect（缓存）→ Principal 映射。
 * auth-center 侧已完成：会话有效性、用户停用、企业资料同步等全部校验。
 */
export async function resolvePrincipal(
  headers: Headers,
  audience: ApiAudience = "employee",
): Promise<Principal> {
  const token = readSessionToken(headers);
  if (!token) throw new AuthenticationError("missing_identity", "登录会话不存在或已失效");
  const remote = await introspectSession(token);
  if (!remote) throw new AuthenticationError("missing_identity", "登录会话不存在或已失效");
  return {
    tenantId: remote.tenantId,
    tenantKey: remote.tenantKey,
    userIdentityId: remote.userIdentityId,
    externalSubject: remote.externalSubject,
    email: remote.email,
    displayName: remote.displayName,
    audience,
    profileStatus: remote.profileStatus ?? "unavailable",
    lastVerifiedAt: remote.lastVerifiedAt ? new Date(remote.lastVerifiedAt) : null,
    enterpriseAttributes: remote.enterpriseAttributes ?? {},
  };
}

/** 显式返回完整的当前用户上下文，供需要企业资料状态的调用方使用。 */
export async function resolveCurrentUserContext(
  headers: Headers,
  audience: ApiAudience = "employee",
): Promise<CurrentUserContext> {
  const principal = await resolvePrincipal(headers, audience);
  return {
    ...principal,
    profileStatus: principal.profileStatus ?? "unavailable",
    lastVerifiedAt: principal.lastVerifiedAt ?? null,
    enterpriseAttributes: principal.enterpriseAttributes ?? {},
  };
}

// ─── Execution Workload Identity（本地验证，不依赖 auth-center）──────

/**
 * Workload 主体：runtime/gateway 执行凭据的可信身份。
 *
 * 与 Principal 的区别：
 * - 不映射到 userIdentity（Runtime/Gateway 无员工身份）。
 * - 携带 WorkloadTokenClaims，供后续 Invocation 校验与幂等账本 caller_type 使用。
 * - callerType 标识身份类型，写入 idempotency_record.caller_type。
 */
export interface WorkloadPrincipal {
  tenantId: string;
  audience: "runtime" | "gateway";
  callerType: "workload";
  /** Workload Token claims，始终是绑定执行权的 execution 凭据。 */
  claims: WorkloadTokenClaims;
  invocationId: string;
  runtimeRevisionId: string;
}

/**
 * 从 Authorization header 解析 Workload 主体（runtime/gateway 执行接口用）。
 * 本地 workload token 解码 + 过期/audience 校验；不依赖 auth-center。
 */
export function resolveWorkloadPrincipal(
  headers: Headers,
  expectedAudience: "runtime" | "gateway",
): WorkloadPrincipal {
  const token = extractBearerToken(headers);
  if (!token) {
    throw new AuthenticationError("missing_identity", `缺少 ${expectedAudience} Workload Token`);
  }

  const claims = decodeWorkloadToken(token);
  assertAudienceMatch(claims, expectedAudience);

  return {
    tenantId: claims.tenantId,
    audience: claims.audience,
    callerType: "workload",
    claims,
    invocationId: claims.invocationId,
    runtimeRevisionId: claims.runtimeRevisionId,
  };
}
