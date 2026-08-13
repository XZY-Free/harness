/**
 * 多维度令牌桶限流器（S12-W02）。
 *
 * 事实源：
 * - docs/architecture/security.md
 * - docs/architecture/security.md S12-W02
 *
 * 职责：
 * - 为 tenant、user、thread、runtime、high_cost 五个维度提供独立令牌桶。
 * - 每个维度独立配置容量（burst）与补充速率（sustained rate）。
 * - checkAndConsume 原子地检查并消耗令牌，返回 allowed + retryAfterMs + remaining。
 * - 进程内内存状态（热路径不查 DB）；多实例部署时各实例独立计算（保守策略，总限流 = 单实例 × 实例数）。
 *
 * 关键约束：
 * - 限流是 fail-closed：令牌不足时返回 allowed=false，调用方必须返回 429。
 * - retryAfterMs 按 (1 / refillRatePerSecond) * 1000 向上取整计算，确保重试时有足够令牌。
 * - 不静默丢持久事件：SSE 场景的持久事件限流由 sse-connection-quota 负责连接级控制，
 * 事件写入路径（turn-queries）不受 HTTP 限流影响（走内部调用，不经 HTTP）。
 */
/** 限流维度。 */
export type RateLimitScopeType = "tenant" | "user" | "thread" | "runtime" | "high_cost";

/** 令牌桶配置。 */
export interface RateLimitConfig {
  /** 桶容量（最大突发）。 */
  capacity: number;
  /** 每秒补充速率（持续速率）。 */
  refillRatePerSecond: number;
}

/** 各维度的默认配置。 */
export const DEFAULT_RATE_LIMIT_CONFIGS: Record<RateLimitScopeType, RateLimitConfig> = {
  tenant: { capacity: 1000, refillRatePerSecond: 500 },
  user: { capacity: 200, refillRatePerSecond: 100 },
  thread: { capacity: 100, refillRatePerSecond: 50 },
  runtime: { capacity: 300, refillRatePerSecond: 150 },
  high_cost: { capacity: 10, refillRatePerSecond: 2 },
};

/** 限流检查结果。 */
export interface RateLimitResult {
  /** 是否放行。 */
  allowed: boolean;
  /** 重试等待毫秒（allowed=false 时有意义；allowed=true 时为 0）。 */
  retryAfterMs: number;
  /** 剩余令牌数。 */
  remaining: number;
  /** 桶容量。 */
  limit: number;
  /** 被限流的维度。 */
  scopeType: RateLimitScopeType;
  /** 维度键（如 tenant:tnt_xxx）。 */
  scopeKey: string;
}

/** 单个令牌桶的内部状态。 */
interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

/** 令牌桶限流器实例。 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly configs: Record<RateLimitScopeType, RateLimitConfig>;

  constructor(configs?: Partial<Record<RateLimitScopeType, RateLimitConfig>>) {
    this.configs = { ...DEFAULT_RATE_LIMIT_CONFIGS, ...configs };
  }

  /**
   * 检查并消耗令牌。
   *
   * @param scopeType 维度类型
   * @param scopeId 维度标识（如 tenantId、userId）
   * @param cost 消耗令牌数（默认 1）
   * @returns 限流结果
   */
  checkAndConsume(scopeType: RateLimitScopeType, scopeId: string, cost = 1): RateLimitResult {
    const config = this.configs[scopeType];
    const scopeKey = `${scopeType}:${scopeId}`;
    const now = Date.now();

    let bucket = this.buckets.get(scopeKey);
    if (!bucket) {
      bucket = { tokens: config.capacity, lastRefillMs: now };
      this.buckets.set(scopeKey, bucket);
    }

    // 补充令牌
    const elapsedMs = now - bucket.lastRefillMs;
    const refilled = (elapsedMs / 1000) * config.refillRatePerSecond;
    bucket.tokens = Math.min(config.capacity, bucket.tokens + refilled);
    bucket.lastRefillMs = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.floor(bucket.tokens),
        limit: config.capacity,
        scopeType,
        scopeKey,
      };
    }

    // 令牌不足：计算重试等待时间
    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / config.refillRatePerSecond) * 1000);

    return {
      allowed: false,
      retryAfterMs: Math.max(retryAfterMs, 1),
      remaining: Math.floor(bucket.tokens),
      limit: config.capacity,
      scopeType,
      scopeKey,
    };
  }

  /**
   * 批量检查多个维度（按优先级顺序）。
   *
   * 第一个被限流的维度即返回（短路）；全部通过则消耗所有维度令牌。
   *
   * @param scopes 维度列表 [{ scopeType, scopeId, cost }]
   * @returns 第一个被限流的结果，或全部通过时的最后一个结果
   */
  checkAndConsumeBatch(
    scopes: Array<{ scopeType: RateLimitScopeType; scopeId: string; cost?: number }>,
  ): RateLimitResult {
    // 先检查所有维度（不消耗），任一不足即返回
    for (const { scopeType, scopeId, cost } of scopes) {
      const result = this.peek(scopeType, scopeId, cost ?? 1);
      if (!result.allowed) {
        return result;
      }
    }

    // 全部通过，逐个消耗，返回最后一个结果
    let lastResult: RateLimitResult | null = null;
    for (const { scopeType, scopeId, cost } of scopes) {
      lastResult = this.checkAndConsume(scopeType, scopeId, cost ?? 1);
    }
    if (!lastResult) {
      throw new Error("checkAndConsumeBatch: scopes must not be empty");
    }
    return lastResult;
  }

  /**
   * 查看令牌是否足够但不消耗。
   */
  peek(scopeType: RateLimitScopeType, scopeId: string, cost = 1): RateLimitResult {
    const config = this.configs[scopeType];
    const scopeKey = `${scopeType}:${scopeId}`;
    const now = Date.now();

    let bucket = this.buckets.get(scopeKey);
    if (!bucket) {
      bucket = { tokens: config.capacity, lastRefillMs: now };
      this.buckets.set(scopeKey, bucket);
    }

    const elapsedMs = now - bucket.lastRefillMs;
    const refilled = (elapsedMs / 1000) * config.refillRatePerSecond;
    const currentTokens = Math.min(config.capacity, bucket.tokens + refilled);

    if (currentTokens >= cost) {
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.floor(currentTokens),
        limit: config.capacity,
        scopeType,
        scopeKey,
      };
    }

    const deficit = cost - currentTokens;
    const retryAfterMs = Math.ceil((deficit / config.refillRatePerSecond) * 1000);
    return {
      allowed: false,
      retryAfterMs: Math.max(retryAfterMs, 1),
      remaining: Math.floor(currentTokens),
      limit: config.capacity,
      scopeType,
      scopeKey,
    };
  }

  /** 获取各维度配置（管理端点只读视图）。 */
  getConfigs(): Record<RateLimitScopeType, RateLimitConfig> {
    return { ...this.configs };
  }

  /** 获取当前令牌数（调试用）。 */
  getTokens(scopeType: RateLimitScopeType, scopeId: string): number {
    const config = this.configs[scopeType];
    const scopeKey = `${scopeType}:${scopeId}`;
    const now = Date.now();

    const bucket = this.buckets.get(scopeKey);
    if (!bucket) return config.capacity;

    const elapsedMs = now - bucket.lastRefillMs;
    const refilled = (elapsedMs / 1000) * config.refillRatePerSecond;
    return Math.min(config.capacity, bucket.tokens + refilled);
  }

  /** 清除指定维度的桶（测试用）。 */
  reset(): void {
    this.buckets.clear();
  }
}

/** 进程级单例（所有请求共享同一限流器实例）。 */
let globalRateLimiter: TokenBucketRateLimiter | null = null;

/** 获取全局限流器单例。 */
export function getRateLimiter(): TokenBucketRateLimiter {
  if (!globalRateLimiter) {
    globalRateLimiter = new TokenBucketRateLimiter();
  }
  return globalRateLimiter;
}

/** 重置全局限流器（测试用）。 */
export function resetRateLimiter(): void {
  globalRateLimiter = null;
}

/** 替换全局限流器（测试专用，允许注入自定义配置）。 */
export function setRateLimiterForTesting(limiter: TokenBucketRateLimiter): void {
  globalRateLimiter = limiter;
}
