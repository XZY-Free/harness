/**
 * identity-client 企业用户上下文（agent 执行链装配）。
 *
 * 走 auth-center `POST /api/enterprise/user-context`（会话主体=目标用户）：
 * - 200：`{ candidate }`（Date 字段为 ISO 字符串；null 表示 profileRequirement=none）。
 * - 403/409：权威错误（稳定错误码在 `error.code`）→ 抛 `EnterpriseContextRpcError`。
 * - 401：会话失效 → `EnterpriseContextRpcError`（调用方按不可用 fail-closed）。
 * - 网络失败/超时/5xx：`AuthCenterUnavailableError`。
 *
 * 本模块只做线上（wire）层：内核类型（Date 还原、错误类映射）由薄壳
 * `lib/identity/prepare-enterprise-user-context.ts` 完成。
 */
import { identityClientConfig } from "./config";
import { AuthCenterUnavailableError, bearerHeaders, requestAuthCenter } from "./http";
import { getActiveTokenForUser } from "./session";

/** auth-center 权威拒绝（HTTP 403/409/401）：携带稳定错误码。 */
export class EnterpriseContextRpcError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "EnterpriseContextRpcError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 线上候选（Date 字段 = ISO 字符串）。 */
export interface WireEnterpriseUserContextCandidate {
  readonly publicContext: {
    readonly context_version: string;
    readonly profile_status: string;
    readonly last_verified_at: string;
    readonly fields: Record<string, unknown>;
  };
  readonly evidence: {
    readonly tenantId: string;
    readonly userIdentityId: string;
    readonly profileRequirement: string;
    readonly sourceSystem: string;
    readonly profileFingerprint: string | null;
    readonly lastVerifiedAt: string;
    readonly freshUntil: string;
    readonly staleUntil: string;
    readonly maxFreshAgeMs: number;
    readonly maxStaleAgeMs: number;
  };
}

/**
 * 装配企业用户上下文候选。
 *
 * @throws AuthCenterUnavailableError 无活跃凭证 / 网络失败 / 超时 / 5xx
 * @throws EnterpriseContextRpcError 权威拒绝（主体不匹配 / 资料不可用 / 用户停用 / 会话失效）
 */
export async function fetchEnterpriseUserContext(params: {
  readonly tenantId: string;
  readonly userIdentityId: string;
  readonly profileRequirement: "stale_allowed" | "fresh_required";
  readonly allowedFields: readonly string[];
  readonly deadlineAt?: Date;
}): Promise<WireEnterpriseUserContextCandidate | null> {
  const token = getActiveTokenForUser(params.userIdentityId);
  if (!token) {
    throw new AuthCenterUnavailableError(
      `用户 ${params.userIdentityId} 无活跃凭证，无法装配企业上下文`,
    );
  }
  const { status, data } = await requestAuthCenter<{
    candidate?: WireEnterpriseUserContextCandidate | null;
    error?: { code?: string; message?: string };
  }>(
    "/api/enterprise/user-context",
    {
      method: "POST",
      headers: bearerHeaders(token),
      body: JSON.stringify({
        tenantId: params.tenantId,
        userIdentityId: params.userIdentityId,
        profileRequirement: params.profileRequirement,
        allowedFields: [...params.allowedFields],
        ...(params.deadlineAt ? { deadlineAt: params.deadlineAt.toISOString() } : {}),
      }),
    },
    // 刷新等待上限（10s）大于默认请求超时（5s），须显式放宽。
    { timeoutMs: identityClientConfig.enterpriseContextTimeoutMs },
  );
  if (status === 200) {
    return data?.candidate ?? null;
  }
  if (status === 401 || status === 403 || status === 409) {
    throw new EnterpriseContextRpcError(
      data?.error?.code ?? "ENTERPRISE_USER_CONTEXT_UNAVAILABLE",
      data?.error?.message ?? `企业上下文调用被拒绝（${status}）`,
      status,
    );
  }
  throw new AuthCenterUnavailableError(`企业上下文异常响应（${status}）`);
}
