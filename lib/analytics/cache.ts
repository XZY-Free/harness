/**
 * Analytics 聚合查询 TTL 内存缓存。
 *
 * analytics 7 指标直接查 DB(threadSuccessRate/toolFailureBreakdown/perSkillPerformance
 * 涉及 groupBy + join),/studio 总览页每次刷新全跑,无缓存。数据量增长后慢。
 *
 * 本模块提供进程级 TTL 内存缓存(默认 60s),按 cache key 命中。
 * - 缓存为进程级单实例(单实例部署语义);多实例下各自缓存,近似有效。
 * - TTL 到期后下次访问重新查 DB(惰性失效,不主动刷新)。
 * - 提供 clearAnalyticsCache() 供测试隔离与强制刷新使用。
 *
 * 缓存只缓存"纯只读聚合结果"(queries.ts 头号纪律:只 select 不 mutate),
 * 不破坏零回归承诺。缓存 miss 时调用 loader,loader 内部仍走 db.select。
 */

const DEFAULT_TTL_MS = Number.parseInt(process.env.SNOW_ANALYTICS_CACHE_TTL_MS ?? "60000", 10);
const TTL_MS = Number.isFinite(DEFAULT_TTL_MS) && DEFAULT_TTL_MS >= 0 ? DEFAULT_TTL_MS : 60_000;

type CacheEntry = { value: unknown; expiresAt: number };

const cache = new Map<string, CacheEntry>();

/** 稳定序列化 scope 作为 cache key(与 keyPrefix 组合)。 */
function scopeKey(scope: unknown): string {
  if (scope === undefined || scope === null) return "global";
  try {
    // key 排序保证 {a,b} 与 {b,a} 同 key
    const sorted = JSON.stringify(scope, Object.keys(scope as object).sort());
    return sorted;
  } catch {
    // scope 含循环引用等异常 → 退化为全局 key(不缓存区分,但仍可缓存)
    return "scope-unserializable";
  }
}

/**
 * 带 TTL 缓存的聚合查询包装。
 *
 * @param keyPrefix 函数名(如 "threadSuccessRate"),与 scopeKey 组合成唯一 key
 * @param scope AnalyticsScope,用于区分不同时间窗/用户
 * @param loader 缓存 miss 时的真实查询函数
 * @returns 聚合结果(命中缓存返回缓存值,否则 loader 结果并缓存)
 */
export async function withAnalyticsCache<T>(
  keyPrefix: string,
  scope: unknown,
  loader: () => Promise<T>,
): Promise<T> {
  // TTL=0 表示禁用缓存(保留旧行为,供排查/测试)
  if (TTL_MS === 0) return loader();

  const key = `${keyPrefix}:${scopeKey(scope)}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }

  const value = await loader();
  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

/** 清空全部 analytics 缓存(供测试隔离与强制刷新)。 */
export function clearAnalyticsCache(): void {
  cache.clear();
}
