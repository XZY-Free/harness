/**
 * identity-client 用户目录读（显示用途）：单读/批量 + 分钟级缓存。
 *
 * 用途：负责人/成员显示名等展示字段；不用于授权判断。
 */
import { identityClientConfig } from "./config";
import { bearerHeaders, requestAuthCenter } from "./http";
import { getActiveTokenForUser } from "./session";

export interface DirectoryUser {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string;
  readonly loginAccount: string | null;
  readonly status: string;
}

const directoryCache = new Map<string, { user: DirectoryUser; expiresAtMs: number }>();

function pruneDirectory(now: number): void {
  for (const [key, entry] of directoryCache) {
    if (entry.expiresAtMs <= now) directoryCache.delete(key);
  }
}

/**
 * 批量查询用户目录（缓存 1min；未找到的 id 不返回）。
 * @throws AuthCenterUnavailableError 无凭证或服务不可达
 */
export async function lookupUsers(
  userIdentityId: string,
  ids: readonly string[],
): Promise<Map<string, DirectoryUser>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const result = new Map<string, DirectoryUser>();
  if (unique.length === 0) return result;

  const now = Date.now();
  pruneDirectory(now);
  const missing: string[] = [];
  for (const id of unique) {
    const cached = directoryCache.get(id);
    if (cached && cached.expiresAtMs > now) result.set(id, cached.user);
    else missing.push(id);
  }
  if (missing.length === 0) return result;

  const token = getActiveTokenForUser(userIdentityId);
  if (!token) return result;
  const { status, data } = await requestAuthCenter<{ users?: DirectoryUser[] }>(
    "/api/directory/users/batch",
    { method: "POST", headers: bearerHeaders(token), body: JSON.stringify({ ids: missing }) },
  );
  if (status !== 200 || !data?.users) return result;
  for (const user of data.users) {
    directoryCache.set(user.id, {
      user,
      expiresAtMs: now + identityClientConfig.directoryCacheTtlMs,
    });
    result.set(user.id, user);
  }
  return result;
}

/** 清空目录缓存（测试/治理用）。 */
export function clearDirectoryCache(): void {
  directoryCache.clear();
}
