/**
 * 身份解析器。
 *
 * 从请求 header 解析可信身份 → 映射到租户内稳定 userIdentity → 返回 Principal。
 *
 * 安全边界：
 * - Web 与 Desktop 都使用相同的数据库会话 cookie。
 * - 缺少、过期或已撤销的会话直接 401 AUTHENTICATION_REQUIRED。
 *
 * audience=runtime/gateway/admin 的 Workload Token 验证见 resolveWorkloadPrincipal。
 */
import { type ApiAudience, apiError, generateRequestId } from "@/lib/http";
import { acceptEnterpriseProfileObservation } from "@/lib/identity/accept-enterprise-profile-observation";
import type {
  AuthenticatedUserEvidence,
  UserAuthenticationProvider,
} from "@/lib/identity/authentication-provider";
import type {
  EnterpriseProfileObservation,
  EnterpriseProfileSource,
} from "@/lib/identity/enterprise-profile-source";
import type { NormalizedEnterpriseUserProfile } from "@/lib/identity/enterprise-user";
import {
  attributesFromRows,
  getEnterpriseUserProfileFacts,
} from "@/lib/identity/enterprise-user-profile-queries";
import { getIdentityExtensions } from "@/lib/identity/identity-extension-bootstrap";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { getUserIdentityBySubject, upsertUserIdentity } from "@/lib/identity/user-identity-queries";
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
  /** 企业资料健康状态；default 模式为 unavailable，不影响标准身份使用。 */
  profileStatus?: EnterpriseUserProfileStatus;
  lastVerifiedAt?: Date | null;
  /** 服务端当前上下文使用的规范化企业字段，不包含 token/raw profile。 */
  enterpriseAttributes?: NormalizedEnterpriseUserProfile["attributes"];
}

/** 当前用户上下文的强类型形式；普通 Principal 兼容保留为可选扩展。 */
export interface CurrentUserContext extends Principal {
  profileStatus: EnterpriseUserProfileStatus;
  lastVerifiedAt: Date | null;
  enterpriseAttributes: NormalizedEnterpriseUserProfile["attributes"];
}

export type EnterpriseUserProfileStatus = "fresh" | "stale" | "unavailable" | "disabled";

interface ResolvedEnterpriseProfile {
  userIdentity: Awaited<ReturnType<typeof upsertUserIdentity>>;
  profileStatus: EnterpriseUserProfileStatus;
  lastVerifiedAt: Date | null;
  profileFingerprint: string | null;
  attributes: NormalizedEnterpriseUserProfile["attributes"];
}

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
  }
}

/** Resolver 注入仅用于受控测试；生产始终从唯一注册表选择正式认证提供器。 */
export interface ResolvePrincipalOptions {
  /** 仅用于受控测试和静态私有装配；生产默认使用冻结扩展。 */
  authenticationProvider?: UserAuthenticationProvider;
}

interface AcceptAuthenticatedEvidenceOptions {
  tenant?: Awaited<ReturnType<typeof ensureDefaultTenant>>;
  profileSource?: EnterpriseProfileSource;
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
 * 从请求解析 可信主体（HTTP route 入口用）。
 *
 * 流程：ensureDefaultTenant → resolveRawIdentity → upsertUserIdentity → upsertPrincipalBinding。
 * 返回的 Principal 包含 tenantId 和 userIdentityId，供后续授权和业务使用。
 */
export async function resolvePrincipal(
  headers: Headers,
  audience: ApiAudience = "employee",
  options: ResolvePrincipalOptions = {},
): Promise<Principal> {
  const tenant = await ensureDefaultTenant();
  if (tenant.status !== "active") {
    throw new AuthenticationError("tenant_suspended", "租户已被暂停");
  }

  const extension = await getIdentityExtensions();
  const authenticationProvider = options.authenticationProvider ?? extension.authenticationProvider;
  const authentication = await authenticationProvider.authenticate({ headers });
  if (authentication.status === "unauthenticated") {
    throw new AuthenticationError("missing_identity", "登录会话不存在或已失效");
  }
  if (authentication.status === "denied") {
    const code = authentication.reason.includes("邮箱") ? "missing_email" : "authentication_denied";
    throw new AuthenticationError(code, authentication.reason);
  }
  return acceptAuthenticatedEvidence(authentication.evidence, audience, {
    tenant,
    profileSource: extension.profileSource,
  });
}

/**
 * 接纳认证提供器已经验证过的证据，并完成 Core 身份、企业资料与主体绑定写入。
 * callback 入口必须直接调用本函数，不能再调用 authenticate 重新认证。
 */
export async function acceptAuthenticatedEvidence(
  evidence: AuthenticatedUserEvidence,
  audience: ApiAudience = "employee",
  options: AcceptAuthenticatedEvidenceOptions = {},
): Promise<Principal> {
  const tenant = options.tenant ?? (await ensureDefaultTenant());
  if (tenant.status !== "active") {
    throw new AuthenticationError("tenant_suspended", "租户已被暂停");
  }

  const { externalSubject, email, displayName } = evidence;
  const existingIdentity = await getUserIdentityBySubject(tenant.id, externalSubject);
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject,
    email: existingIdentity?.status === "disabled" ? existingIdentity.email : email,
    displayName:
      existingIdentity?.status === "disabled" ? existingIdentity.displayName : displayName,
  });
  const synced = options.profileSource
    ? await resolveConfiguredProfile({
        tenant,
        userIdentity: identity,
        source: options.profileSource,
        observation: evidence.enterpriseProfileObservation,
      })
    : {
        userIdentity: identity,
        profileStatus: "unavailable" as const,
        lastVerifiedAt: null,
        profileFingerprint: null,
        attributes: {},
      };

  // Employee Principal 是全部员工业务 API 的统一门禁；已停用用户不能建立绑定、
  // 不能继续业务请求，也不能借认证或资料来源失败走 stale 路径恢复为 active。
  if (audience === "employee" && synced.userIdentity.status === "disabled") {
    throw new AuthenticationError("user_disabled", "当前用户已停用");
  }

  // 同步后使用认证链确认过的标准字段建立绑定，避免身份资料漂移后绑定显示名落后。
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: externalSubject,
    displayName: synced.userIdentity.displayName,
    userIdentityId: synced.userIdentity.id,
  });

  return {
    tenantId: tenant.id,
    tenantKey: tenant.key,
    userIdentityId: synced.userIdentity.id,
    externalSubject,
    email: synced.userIdentity.email,
    displayName: synced.userIdentity.displayName,
    audience,
    profileStatus: synced.profileStatus,
    lastVerifiedAt: synced.lastVerifiedAt,
    enterpriseAttributes: synced.attributes,
  };
}

async function resolveConfiguredProfile(params: {
  tenant: { id: string; key: string };
  userIdentity: Awaited<ReturnType<typeof upsertUserIdentity>>;
  source: NonNullable<Awaited<ReturnType<typeof getIdentityExtensions>>["profileSource"]>;
  observation?: EnterpriseProfileObservation;
}): Promise<ResolvedEnterpriseProfile> {
  const now = new Date();
  if (params.observation) {
    await acceptEnterpriseProfileObservation({
      observation: params.observation,
      source: params.source,
      expectedSubject: {
        tenantId: params.tenant.id,
        userIdentityId: params.userIdentity.id,
        externalSubject: params.userIdentity.externalSubject,
      },
      now,
    });
  }
  const facts = await getEnterpriseUserProfileFacts(params.tenant.id, params.userIdentity.id);
  const state = facts?.syncState;
  if (!state || !params.source.trusted) {
    return {
      userIdentity: params.userIdentity,
      profileStatus: "unavailable" as const,
      lastVerifiedAt: state?.lastVerifiedAt ?? null,
      profileFingerprint: state?.profileFingerprint ?? null,
      attributes: {},
    };
  }
  const freshUntil = new Date(
    Math.min(
      state.freshUntil.getTime(),
      state.lastVerifiedAt.getTime() + params.source.maxFreshAgeMs,
    ),
  );
  const staleUntil = new Date(
    Math.min(state.staleUntil.getTime(), freshUntil.getTime() + params.source.maxStaleAgeMs),
  );
  const profileStatus: EnterpriseUserProfileStatus =
    params.userIdentity.status === "disabled"
      ? "disabled"
      : now < freshUntil
        ? "fresh"
        : now < staleUntil
          ? "stale"
          : "unavailable";
  return {
    userIdentity: params.userIdentity,
    profileStatus,
    lastVerifiedAt: state.lastVerifiedAt,
    profileFingerprint: state.profileFingerprint,
    attributes: attributesFromRows(facts.attributes),
  };
}

/** 显式返回完整的当前用户上下文，供需要企业资料状态的调用方使用。 */
export async function resolveCurrentUserContext(
  headers: Headers,
  audience: ApiAudience = "employee",
): Promise<CurrentUserContext> {
  const principal = await resolvePrincipal(headers, audience);
  if (
    !principal.profileStatus ||
    principal.lastVerifiedAt === undefined ||
    !principal.enterpriseAttributes
  ) {
    throw new Error("当前用户上下文缺少企业资料状态");
  }
  return principal as CurrentUserContext;
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
