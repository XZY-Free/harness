/**
 * identity-client 权限快照：类型、缓存与拉取。
 *
 * 快照由 auth-center `GET /api/permissions/snapshot` 产出（预展开清单：
 * grant 已展开、来源已标注、企业授权已按 agent 目录求值）。
 * 消费方缓存 5~15min，用于读路径本地匹配（evaluateSnapshot）与覆盖投影
 * （coverageFromSnapshot）；变更/敏感操作不走快照，走实时 authorize。
 */
import { identityClientConfig } from "./config";
import { AuthCenterUnavailableError, bearerHeaders, requestAuthCenter } from "./http";
import { getActiveTokenForUser } from "./session";

export interface SnapshotResourceScope {
  readonly type: string;
  readonly ids?: readonly string[];
  readonly wildcard?: boolean;
}

export interface SnapshotGrant {
  readonly actionCode: string;
  readonly resourceScope: SnapshotResourceScope;
  readonly source: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface SnapshotPolicy {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly mode: string;
  readonly principals: unknown;
  readonly collaborators: unknown;
  readonly version: number;
}

export interface SnapshotAgent {
  readonly id: string;
  readonly ownerUserId: string;
  readonly lifecycleState: string;
  readonly currentRevisionId: string | null;
  readonly deleted: boolean;
}

export interface SnapshotEnterprise {
  readonly agentIds: "all" | readonly string[];
  readonly decisions: Readonly<Record<string, { allowed: boolean; reason?: string }>>;
}

export interface PermissionSnapshot {
  readonly digest: string;
  readonly generatedAt: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly active: boolean;
  readonly principalIds: readonly string[];
  readonly grants: readonly SnapshotGrant[];
  readonly policies: readonly SnapshotPolicy[];
  readonly agents: readonly SnapshotAgent[];
  readonly enterprise: SnapshotEnterprise | null;
}

interface SnapshotCacheEntry {
  readonly snapshot: PermissionSnapshot;
  readonly expiresAtMs: number;
}

const snapshotCache = new Map<string, SnapshotCacheEntry>();

function cacheKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

/** 仅读缓存（不触发网络）；过期返回 null。用于 check 路径的机会式本地匹配。 */
export function peekSnapshot(tenantId: string, userId: string): PermissionSnapshot | null {
  const entry = snapshotCache.get(cacheKey(tenantId, userId));
  if (!entry || entry.expiresAtMs <= Date.now()) return null;
  return entry.snapshot;
}

/**
 * 取权限快照（缓存 5~15min；可强制刷新）。
 * @throws AuthCenterUnavailableError 无可用凭证或服务不可达
 */
export async function getSnapshot(
  tenantId: string,
  userId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<PermissionSnapshot> {
  const key = cacheKey(tenantId, userId);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = snapshotCache.get(key);
    if (cached && cached.expiresAtMs > now) return cached.snapshot;
  }
  const token = getActiveTokenForUser(userId);
  if (!token) {
    throw new AuthCenterUnavailableError(`用户 ${userId} 无活跃凭证，无法拉取权限快照`);
  }
  const { status, data } = await requestAuthCenter<PermissionSnapshot>(
    "/api/permissions/snapshot",
    {
      headers: bearerHeaders(token),
    },
  );
  if (status === 401) {
    throw new AuthCenterUnavailableError(`拉取权限快照被拒（会话失效）：${userId}`);
  }
  if (status !== 200 || !data) {
    throw new AuthCenterUnavailableError(`权限快照异常响应（${status}）：${userId}`);
  }
  snapshotCache.set(key, {
    snapshot: data,
    expiresAtMs: now + identityClientConfig.snapshotCacheTtlMs,
  });
  return data;
}

/** 写入快照缓存（票据兑换的 resolve 响应自带快照，直接预热）。 */
export function seedSnapshotCache(snapshot: PermissionSnapshot): void {
  if (!snapshot?.tenantId || !snapshot.userId) return;
  snapshotCache.set(cacheKey(snapshot.tenantId, snapshot.userId), {
    snapshot,
    expiresAtMs: Date.now() + identityClientConfig.snapshotCacheTtlMs,
  });
}

/** 清空快照缓存（测试/治理用）。 */
export function clearSnapshotCache(): void {
  snapshotCache.clear();
}
