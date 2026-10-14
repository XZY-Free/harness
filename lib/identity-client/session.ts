/**
 * identity-client 会话层：token 提取、introspect（带缓存）、票据兑换。
 *
 * 消费方模型（docs/split 施工图 v4）：
 * - nexharness 不再持有本地会话表；cookie `nex_session` 的值就是 auth-center 会话 token。
 * - 每请求校验走 auth-center `POST /api/session/introspect`，进程内缓存 30~60s。
 * - 票据（登录回跳 `?ticket=`）由 `exchangeTicket` 一次性兑换为会话 token。
 *
 * token↔用户 注册表：authorize/snapshot/coverage 等按用户维度的后续调用复用
 * 当前活跃 token（服务进程内最近一次成功校验/兑换的凭证）。
 */
import { identityClientConfig } from "./config";
import { AuthCenterUnavailableError, bearerHeaders, requestAuthCenter } from "./http";

/** 会话 cookie 名（与 auth-center 保持一致；开发期同 host 天然共享）。 */
export const SESSION_COOKIE_NAME = "nex_session";

/** 远端主体快照（auth-center introspect/resolve 的 principal 投影）。 */
export interface RemotePrincipal {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userIdentityId: string;
  readonly externalSubject: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly audience: string;
  readonly profileStatus: "fresh" | "stale" | "unavailable" | "disabled" | null;
  readonly lastVerifiedAt: string | null;
  readonly enterpriseAttributes: Record<string, unknown>;
}

interface SessionCacheEntry {
  readonly principal: RemotePrincipal;
  readonly expiresAtMs: number;
}

const sessionCache = new Map<string, SessionCacheEntry>();
const tokenByUser = new Map<string, { token: string; expiresAtMs: number }>();

function pruneAndBound(map: Map<string, { expiresAtMs: number }>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.expiresAtMs <= now) map.delete(key);
  }
  const max = identityClientConfig.maxSessionEntries;
  if (map.size > max) {
    const excess = map.size - max;
    let removed = 0;
    for (const key of map.keys()) {
      map.delete(key);
      if (++removed >= excess) break;
    }
  }
}

/** 读取请求中的会话 token（cookie 优先，其次 Authorization: Bearer）。 */
export function readSessionToken(headers: Headers): string | null {
  const raw = headers.get("cookie");
  if (raw) {
    for (const part of raw.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
      const value = part.slice(separator + 1).trim();
      if (value) return value;
    }
  }
  const authorization = headers.get("authorization");
  const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
  return match?.[1]?.trim() || null;
}

/**
 * 校验会话 token：命中缓存直接返回；否则调用 auth-center introspect。
 *
 * @returns null = 会话无效/过期/已撤销；抛 AuthCenterUnavailableError = 服务不可达
 */
export async function introspectSession(
  token: string,
  options: { bypassCache?: boolean } = {},
): Promise<RemotePrincipal | null> {
  const now = Date.now();
  if (!options.bypassCache) {
    const cached = sessionCache.get(token);
    if (cached && cached.expiresAtMs > now) return cached.principal;
  }
  const { status, data } = await requestAuthCenter<{
    principal?: RemotePrincipal;
    expiresAt?: string;
    error?: { message?: string };
  }>("/api/session/introspect", { method: "POST", headers: bearerHeaders(token) });
  if (status === 401) {
    sessionCache.delete(token);
    return null;
  }
  if (status !== 200 || !data?.principal) {
    throw new AuthCenterUnavailableError(`introspect 异常响应（${status}）`);
  }
  const principal = data.principal;
  const sessionExpiryMs = data.expiresAt ? Date.parse(data.expiresAt) : Number.POSITIVE_INFINITY;
  const cacheExpiry = Math.min(now + identityClientConfig.sessionCacheTtlMs, sessionExpiryMs);
  sessionCache.set(token, { principal, expiresAtMs: cacheExpiry });
  tokenByUser.set(principal.userIdentityId, { token, expiresAtMs: cacheExpiry });
  pruneAndBound(sessionCache, now);
  pruneAndBound(tokenByUser, now);
  return principal;
}

/** 取用户当前活跃 token（服务进程内最近校验/兑换的凭证）。 */
export function getActiveTokenForUser(userIdentityId: string): string | null {
  const now = Date.now();
  const entry = tokenByUser.get(userIdentityId);
  if (!entry || entry.expiresAtMs <= now) {
    tokenByUser.delete(userIdentityId);
    return null;
  }
  return entry.token;
}

/** 票据兑换结果（登录回跳用）。 */
export interface TicketExchangeResult {
  readonly principal: RemotePrincipal;
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly snapshot: unknown;
}

/**
 * 用一次性票据兑换会话（auth-center `POST /api/session/resolve`）。
 * 成功后同时预热会话缓存与快照缓存。
 */
export async function exchangeTicket(ticket: string): Promise<TicketExchangeResult | null> {
  const { status, data } = await requestAuthCenter<{
    principal?: RemotePrincipal;
    sessionToken?: string;
    expiresAt?: string;
    snapshot?: unknown;
  }>("/api/session/resolve", {
    method: "POST",
    body: JSON.stringify({ ticket }),
  });
  if (status !== 200 || !data?.principal || !data.sessionToken || !data.expiresAt) return null;
  const now = Date.now();
  const sessionExpiryMs = Date.parse(data.expiresAt);
  const cacheExpiry = Math.min(now + identityClientConfig.sessionCacheTtlMs, sessionExpiryMs);
  sessionCache.set(data.sessionToken, { principal: data.principal, expiresAtMs: cacheExpiry });
  tokenByUser.set(data.principal.userIdentityId, {
    token: data.sessionToken,
    expiresAtMs: cacheExpiry,
  });
  return {
    principal: data.principal,
    sessionToken: data.sessionToken,
    expiresAt: data.expiresAt,
    snapshot: data.snapshot ?? null,
  };
}

/** 清空进程内会话缓存（测试/治理用）。 */
export function clearIdentityClientCaches(): void {
  sessionCache.clear();
  tokenByUser.clear();
}
