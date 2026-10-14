/**
 * identity-client 配置。
 *
 * NEX_AUTH_CENTER_URL：auth-center 对外地址。
 * - 开发：http://localhost:3101（vite 门户，/api 反代到 API 服务；页面与 API 同源）
 * - 生产：auth-center 自身服务地址（同源伺服 web/dist + API）
 *
 * 缓存语义（消费方模型，见 docs/split 施工图 v4）：
 * - 会话校验（introspect）：缓存 30~60s——登出/停用的最坏传播窗口。
 * - 权限快照（snapshot）：缓存 5~15min——读路径本地匹配依据。
 * - 变更/敏感操作：绕过缓存走实时 authorize（fail-closed）。
 */
export const identityClientConfig = {
  get baseUrl(): string {
    return (process.env.NEX_AUTH_CENTER_URL ?? "http://localhost:3101").replace(/\/+$/, "");
  },
  /** 会话缓存 TTL（毫秒）。 */
  get sessionCacheTtlMs(): number {
    return readPositiveInt("NEX_IDENTITY_SESSION_TTL_MS", 45_000);
  },
  /** 权限快照缓存 TTL（毫秒）。 */
  get snapshotCacheTtlMs(): number {
    return readPositiveInt("NEX_IDENTITY_SNAPSHOT_TTL_MS", 600_000);
  },
  /** 目录读缓存 TTL（毫秒）。 */
  get directoryCacheTtlMs(): number {
    return readPositiveInt("NEX_IDENTITY_DIRECTORY_TTL_MS", 60_000);
  },
  /** 单次请求超时（毫秒）。 */
  get requestTimeoutMs(): number {
    return readPositiveInt("NEX_IDENTITY_TIMEOUT_MS", 5_000);
  },
  /** 会话缓存最大条目（防泄漏）。 */
  get maxSessionEntries(): number {
    return readPositiveInt("NEX_IDENTITY_MAX_ENTRIES", 5_000);
  },
} as const;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
