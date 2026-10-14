/**
 * identity-client 实时授权（变更/敏感操作）。
 *
 * 走 auth-center `POST /api/authorize`（不经快照缓存）；服务不可达或无可用
 * 凭证时抛错，由调用方按 fail-closed（拒绝）处理。
 */
import { AuthCenterUnavailableError, bearerHeaders, requestAuthCenter } from "./http";
import { getActiveTokenForUser } from "./session";

export interface AuthorizeRequestItem {
  readonly actionCode: string;
  readonly resource: { readonly type: string; readonly id: string | null };
}

export interface AuthorizeDecisionItem {
  readonly actionCode: string;
  readonly resource: { readonly type: string; readonly id: string | null };
  readonly allowed: boolean;
  readonly reason: string;
  readonly sources: readonly string[];
}

export interface AuthorizeBatchResult {
  readonly decisions: readonly AuthorizeDecisionItem[];
  readonly digest: string;
}

/**
 * 以用户身份发起实时授权（单/批）。
 * @throws AuthCenterUnavailableError 无凭证或服务不可达
 */
export async function authorizeForUser(
  userIdentityId: string,
  requests: readonly AuthorizeRequestItem[],
): Promise<AuthorizeBatchResult> {
  if (requests.length === 0) return { decisions: [], digest: "" };
  const token = getActiveTokenForUser(userIdentityId);
  if (!token) {
    throw new AuthCenterUnavailableError(`用户 ${userIdentityId} 无活跃凭证，无法实时授权`);
  }
  const { status, data } = await requestAuthCenter<AuthorizeBatchResult>("/api/authorize", {
    method: "POST",
    headers: bearerHeaders(token),
    body: JSON.stringify({ requests }),
  });
  if (status !== 200 || !data?.decisions) {
    throw new AuthCenterUnavailableError(`实时授权异常响应（${status}）：${userIdentityId}`);
  }
  return data;
}
