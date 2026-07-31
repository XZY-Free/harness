import {
  OverloadProtector,
  inferPriority,
  resetOverloadProtector,
} from "@/lib/v11/gateway/overload-protection";
import type { OverloadResult } from "@/lib/v11/gateway/overload-protection";
import {
  buildOverloadResponse,
  buildRateLimitResponse,
  buildStreamBackpressureResponse,
  enforceGatewayProtection,
} from "@/lib/v11/gateway/rate-limit-helpers";
import {
  type RateLimitScopeType,
  TokenBucketRateLimiter,
  resetRateLimiter,
  setRateLimiterForTesting,
} from "@/lib/v11/gateway/rate-limiter";
import type { RateLimitResult } from "@/lib/v11/gateway/rate-limiter";
import {
  SSEConnectionQuota,
  resetSSEConnectionQuota,
} from "@/lib/v11/gateway/sse-connection-quota";
import type { SSEQuotaResult } from "@/lib/v11/gateway/sse-connection-quota";
/**
 * S12-W02：V11 限流、过载保护与 SSE 连接配额单元测试。
 *
 * 覆盖：
 * - TokenBucketRateLimiter：令牌补充、容量上限、批量检查、peek 不消耗
 * - OverloadProtector：优先级阈值、acquire/release 配对、绝对上限
 * - SSEConnectionQuota：多维度配额、acquire/release、超限拒绝
 * - rate-limit-helpers：响应构建、enforceGatewayProtection
 * - inferPriority：路径到优先级推断
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  resetOverloadProtector();
  resetSSEConnectionQuota();
  resetRateLimiter();
});

afterEach(() => {
  resetOverloadProtector();
  resetSSEConnectionQuota();
  resetRateLimiter();
});

// ─── TokenBucketRateLimiter ─────────────────────────

describe("TokenBucketRateLimiter", () => {
  it("首次请求从满桶消耗令牌", () => {
    const limiter = new TokenBucketRateLimiter();
    const result = limiter.checkAndConsume("tenant", "tnt_001");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(999); // 1000 - 1
    expect(result.limit).toBe(1000);
    expect(result.retryAfterMs).toBe(0);
  });

  it("令牌不足时返回 allowed=false + retryAfterMs", () => {
    const limiter = new TokenBucketRateLimiter({
      high_cost: { capacity: 2, refillRatePerSecond: 1 },
    });
    // 消耗 2 个令牌（满桶）
    limiter.checkAndConsume("high_cost", "tnt_001", 2);
    // 第 3 个请求被拒
    const result = limiter.checkAndConsume("high_cost", "tnt_001");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.remaining).toBe(0);
  });

  it("令牌按时间补充", async () => {
    const limiter = new TokenBucketRateLimiter({
      user: { capacity: 5, refillRatePerSecond: 100 }, // 100/s = 10ms/token
    });
    // 消耗全部 5 个
    for (let i = 0; i < 5; i++) {
      limiter.checkAndConsume("user", "usr_001");
    }
    expect(limiter.getTokens("user", "usr_001")).toBeLessThan(1);

    // 等待 50ms → 补充约 5 个
    await new Promise((resolve) => setTimeout(resolve, 60));

    const result = limiter.checkAndConsume("user", "usr_001");
    expect(result.allowed).toBe(true);
  });

  it("令牌不超过容量上限", async () => {
    const limiter = new TokenBucketRateLimiter({
      tenant: { capacity: 10, refillRatePerSecond: 1000 },
    });
    // 消耗 5 个
    for (let i = 0; i < 5; i++) {
      limiter.checkAndConsume("tenant", "tnt_001");
    }
    // 等待令牌补充（应远超容量）
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 但不应超过 capacity
    const tokens = limiter.getTokens("tenant", "tnt_001");
    expect(tokens).toBeLessThanOrEqual(10);
  });

  it("不同维度的桶相互独立", () => {
    // refillRatePerSecond=0 避免 consume 与 getTokens 之间补充令牌导致的时序抖动
    const limiter = new TokenBucketRateLimiter({
      tenant: { capacity: 1000, refillRatePerSecond: 0 },
    });
    const r1 = limiter.checkAndConsume("tenant", "tnt_001");
    const r2 = limiter.checkAndConsume("tenant", "tnt_002");
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // 两个租户的桶各自独立
    expect(limiter.getTokens("tenant", "tnt_001")).toBe(999);
    expect(limiter.getTokens("tenant", "tnt_002")).toBe(999);
  });

  it("peek 不消耗令牌", () => {
    const limiter = new TokenBucketRateLimiter({
      high_cost: { capacity: 1, refillRatePerSecond: 1 },
    });
    // peek 不消耗
    const peekResult = limiter.peek("high_cost", "tnt_001");
    expect(peekResult.allowed).toBe(true);
    expect(peekResult.remaining).toBe(1);

    // 实际消耗
    const consumeResult = limiter.checkAndConsume("high_cost", "tnt_001");
    expect(consumeResult.allowed).toBe(true);
    expect(consumeResult.remaining).toBe(0);

    // 再 peek → 不够
    const peekResult2 = limiter.peek("high_cost", "tnt_001");
    expect(peekResult2.allowed).toBe(false);
  });

  it("checkAndConsumeBatch 全部通过时消耗所有维度", () => {
    const limiter = new TokenBucketRateLimiter();
    const result = limiter.checkAndConsumeBatch([
      { scopeType: "tenant", scopeId: "tnt_001" },
      { scopeType: "user", scopeId: "usr_001" },
      { scopeType: "thread", scopeId: "thr_001" },
    ]);
    expect(result.allowed).toBe(true);
    // 三个维度各消耗 1
    expect(limiter.getTokens("tenant", "tnt_001")).toBe(999);
    expect(limiter.getTokens("user", "usr_001")).toBe(199);
    expect(limiter.getTokens("thread", "thr_001")).toBe(99);
  });

  it("checkAndConsumeBatch 任一维度不足时短路返回（不消耗任何维度）", () => {
    const limiter = new TokenBucketRateLimiter({
      high_cost: { capacity: 0, refillRatePerSecond: 1 },
    });
    // high_cost 容量 0 → 永远不够
    const result = limiter.checkAndConsumeBatch([
      { scopeType: "tenant", scopeId: "tnt_001" },
      { scopeType: "high_cost", scopeId: "tnt_001" },
    ]);
    expect(result.allowed).toBe(false);
    expect(result.scopeType).toBe("high_cost");
    // tenant 未被消耗（短路）
    expect(limiter.getTokens("tenant", "tnt_001")).toBe(1000);
  });

  it("reset 清除所有桶", () => {
    const limiter = new TokenBucketRateLimiter();
    limiter.checkAndConsume("tenant", "tnt_001", 100);
    expect(limiter.getTokens("tenant", "tnt_001")).toBe(900);
    limiter.reset();
    expect(limiter.getTokens("tenant", "tnt_001")).toBe(1000);
  });
});

// ─── OverloadProtector ─────────────────────────────

describe("OverloadProtector", () => {
  it("低并发时所有优先级通过", () => {
    const protector = new OverloadProtector({ maxConcurrent: 100 });
    for (const priority of ["critical", "high", "normal", "low"] as const) {
      const result = protector.acquire(priority);
      expect(result.allowed).toBe(true);
      protector.release(priority);
    }
  });

  it("low 优先级在 50% 阈值后被拒绝", () => {
    const protector = new OverloadProtector({ maxConcurrent: 10 });
    // 占满 5 个 low 槽位（50%）
    for (let i = 0; i < 5; i++) {
      const r = protector.acquire("low");
      expect(r.allowed).toBe(true);
    }
    // 第 6 个 low 被拒
    const result = protector.acquire("low");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("priority_threshold_reached");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("critical 优先级在 normal/low 被拒后仍通过", () => {
    const protector = new OverloadProtector({ maxConcurrent: 10 });
    // 占满 7 个（达到 normal 阈值 70%）
    for (let i = 0; i < 7; i++) {
      protector.acquire("critical");
    }
    // normal 被拒
    const normalResult = protector.acquire("normal");
    expect(normalResult.allowed).toBe(false);
    // critical 仍通过
    const criticalResult = protector.acquire("critical");
    expect(criticalResult.allowed).toBe(true);
  });

  it("达到绝对上限时 critical 也被拒", () => {
    const protector = new OverloadProtector({ maxConcurrent: 5 });
    for (let i = 0; i < 5; i++) {
      protector.acquire("critical");
    }
    const result = protector.acquire("critical");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("max_concurrent_reached");
  });

  it("release 后槽位恢复", () => {
    const protector = new OverloadProtector({ maxConcurrent: 2 });
    protector.acquire("normal");
    protector.acquire("normal");
    // 满
    const r1 = protector.acquire("normal");
    expect(r1.allowed).toBe(false);
    // 释放 1 个
    protector.release("normal");
    const r2 = protector.acquire("normal");
    expect(r2.allowed).toBe(true);
  });

  it("getPriorityCounts 返回各优先级计数", () => {
    const protector = new OverloadProtector({ maxConcurrent: 100 });
    protector.acquire("critical");
    protector.acquire("high");
    protector.acquire("high");
    protector.acquire("normal");
    const counts = protector.getPriorityCounts();
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(2);
    expect(counts.normal).toBe(1);
    expect(counts.low).toBe(0);
  });

  it("reset 清零所有计数", () => {
    const protector = new OverloadProtector({ maxConcurrent: 100 });
    protector.acquire("critical");
    protector.acquire("normal");
    protector.reset();
    expect(protector.getConcurrent()).toBe(0);
    expect(protector.getPriorityCounts().critical).toBe(0);
  });
});

// ─── inferPriority ─────────────────────────────────

describe("inferPriority", () => {
  it("取消/停止操作 → critical", () => {
    expect(inferPriority("POST", "/api/v1/jobs/job_001:cancel")).toBe("critical");
    expect(inferPriority("POST", "/api/v1/jobs/job_001:stop")).toBe("critical");
  });

  it("UserAction ack → critical", () => {
    expect(inferPriority("POST", "/api/v1/jobs/job_001:user-action:ack")).toBe("critical");
  });

  it("Audit 写入 → critical", () => {
    expect(inferPriority("POST", "/admin/api/v1/audit/events")).toBe("critical");
  });

  it("副作用核对 → high", () => {
    expect(inferPriority("POST", "/api/v1/invocations/inv_001:reconcile")).toBe("high");
    expect(inferPriority("GET", "/api/v1/invocations/inv_001/effects")).toBe("high");
  });

  it("SSE 订阅 → low", () => {
    expect(inferPriority("GET", "/api/v1/threads/thr_001/events")).toBe("low");
  });

  it("导出/重建 → low", () => {
    expect(inferPriority("POST", "/admin/api/v1/exports")).toBe("low");
    expect(inferPriority("POST", "/admin/api/v1/projections:rebuild")).toBe("low");
  });

  it("常规 API → normal", () => {
    expect(inferPriority("POST", "/api/v1/threads/thr_001/turns")).toBe("normal");
    expect(inferPriority("GET", "/api/v1/threads/thr_001")).toBe("normal");
  });
});

// ─── SSEConnectionQuota ────────────────────────────

describe("SSEConnectionQuota", () => {
  it("首次连接通过", () => {
    const quota = new SSEConnectionQuota();
    const result = quota.acquire("tnt_001", "usr_001", "thr_001");
    expect(result.allowed).toBe(true);
  });

  it("Thread 级配额超限", () => {
    const quota = new SSEConnectionQuota({ maxPerThread: 2 });
    quota.acquire("tnt_001", "usr_001", "thr_001");
    quota.acquire("tnt_001", "usr_002", "thr_001");
    const result = quota.acquire("tnt_001", "usr_003", "thr_001");
    expect(result.allowed).toBe(false);
    expect(result.scope).toBe("thread");
    expect(result.active).toBe(2);
    expect(result.max).toBe(2);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("User 级配额超限", () => {
    const quota = new SSEConnectionQuota({ maxPerUser: 2 });
    quota.acquire("tnt_001", "usr_001", "thr_001");
    quota.acquire("tnt_001", "usr_001", "thr_002");
    const result = quota.acquire("tnt_001", "usr_001", "thr_003");
    expect(result.allowed).toBe(false);
    expect(result.scope).toBe("user");
  });

  it("Tenant 级配额超限", () => {
    const quota = new SSEConnectionQuota({ maxPerTenant: 2 });
    quota.acquire("tnt_001", "usr_001", "thr_001");
    quota.acquire("tnt_001", "usr_002", "thr_002");
    const result = quota.acquire("tnt_001", "usr_003", "thr_003");
    expect(result.allowed).toBe(false);
    expect(result.scope).toBe("tenant");
  });

  it("release 后配额恢复", () => {
    const quota = new SSEConnectionQuota({ maxPerThread: 1 });
    quota.acquire("tnt_001", "usr_001", "thr_001");
    expect(quota.acquire("tnt_001", "usr_002", "thr_001").allowed).toBe(false);
    quota.release("tnt_001", "usr_001", "thr_001");
    expect(quota.acquire("tnt_001", "usr_002", "thr_001").allowed).toBe(true);
  });

  it("不同租户/用户/Thread 的配额独立", () => {
    const quota = new SSEConnectionQuota({ maxPerThread: 1 });
    expect(quota.acquire("tnt_001", "usr_001", "thr_001").allowed).toBe(true);
    expect(quota.acquire("tnt_001", "usr_001", "thr_002").allowed).toBe(true);
    expect(quota.acquire("tnt_002", "usr_002", "thr_003").allowed).toBe(true);
  });

  it("getActive 方法返回正确计数", () => {
    const quota = new SSEConnectionQuota();
    quota.acquire("tnt_001", "usr_001", "thr_001");
    quota.acquire("tnt_001", "usr_001", "thr_002");
    expect(quota.getTenantActive("tnt_001")).toBe(2);
    expect(quota.getUserActive("usr_001")).toBe(2);
    expect(quota.getThreadActive("thr_001")).toBe(1);
  });

  it("release 不会使计数变负", () => {
    const quota = new SSEConnectionQuota();
    quota.release("tnt_001", "usr_001", "thr_001"); // 未 acquire 直接 release
    expect(quota.getTenantActive("tnt_001")).toBe(0);
  });
});

// ─── rate-limit-helpers 响应构建 ────────────────────

describe("rate-limit-helpers 响应构建", () => {
  it("buildRateLimitResponse 返回 429 + Retry-After + details", async () => {
    const result: RateLimitResult = {
      allowed: false,
      retryAfterMs: 500,
      remaining: 0,
      limit: 100,
      scopeType: "tenant",
      scopeKey: "tenant:tnt_001",
    };
    const response = buildRateLimitResponse(result, "req_001");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1"); // ceil(500/1000) = 1
    expect(response.headers.get("x-request-id")).toBe("req_001");

    const body = await response.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryable).toBe(true);
    expect(body.error.details.scope).toBe("tenant");
    expect(body.error.details.retry_after_ms).toBe(500);
    expect(body.error.details.remaining).toBe(0);
    expect(body.error.details.limit).toBe(100);
  });

  it("buildStreamBackpressureResponse 返回 429 + 连接信息", async () => {
    const result: SSEQuotaResult = {
      allowed: false,
      retryAfterMs: 1000,
      scope: "thread",
      active: 10,
      max: 10,
    };
    const response = buildStreamBackpressureResponse(result, "req_002");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");

    const body = await response.json();
    expect(body.error.code).toBe("STREAM_BACKPRESSURE");
    expect(body.error.retryable).toBe(true);
    expect(body.error.details.scope).toBe("thread");
    expect(body.error.details.active).toBe(10);
    expect(body.error.details.max).toBe(10);
  });

  it("buildOverloadResponse 绝对上限 → 503 RUNTIME_UNAVAILABLE", async () => {
    const result: OverloadResult = {
      allowed: false,
      retryAfterMs: 100,
      concurrent: 500,
      maxConcurrent: 500,
      priority: "critical",
      reason: "max_concurrent_reached",
    };
    const response = buildOverloadResponse(result, "req_003");
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error.code).toBe("RUNTIME_UNAVAILABLE");
    expect(body.error.details.reason).toBe("max_concurrent_reached");
    expect(body.error.details.concurrent).toBe(500);
  });

  it("buildOverloadResponse 优先级阈值 → 429 RATE_LIMITED", async () => {
    const result: OverloadResult = {
      allowed: false,
      retryAfterMs: 200,
      concurrent: 260,
      maxConcurrent: 500,
      priority: "low",
      reason: "priority_threshold_reached",
    };
    const response = buildOverloadResponse(result, "req_004");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");

    const body = await response.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.details.priority).toBe("low");
    expect(body.error.details.reason).toBe("priority_threshold_reached");
  });
});

// ─── enforceGatewayProtection 集成 ──────────────────

describe("enforceGatewayProtection", () => {
  it("正常请求通过并返回 releaseOverload", () => {
    const result = enforceGatewayProtection("POST", "/api/v1/threads/thr_001/turns", "req_001", {
      tenantId: "tnt_001",
      userId: "usr_001",
      threadId: "thr_001",
    });
    expect(result.ok).toBe(true);
    expect(result.response).toBe(null);
    expect(result.releaseOverload).not.toBe(null);
    result.releaseOverload?.();
  });

  it("限流拒绝时返回 429 响应", () => {
    // 用自定义配置让令牌立即耗尽
    setRateLimiterForTesting(
      new TokenBucketRateLimiter({
        tenant: { capacity: 1, refillRatePerSecond: 1 },
      }),
    );

    // 第一次通过
    const r1 = enforceGatewayProtection("GET", "/api/v1/threads/thr_001", "req_002", {
      tenantId: "tnt_001",
      userId: "usr_001",
    });
    expect(r1.ok).toBe(true);
    r1.releaseOverload?.();

    // 第二次被拒（tenant 维度）
    const r2 = enforceGatewayProtection("GET", "/api/v1/threads/thr_001", "req_003", {
      tenantId: "tnt_001",
      userId: "usr_001",
    });
    expect(r2.ok).toBe(false);
    expect(r2.response).not.toBe(null);
    expect(r2.response?.status).toBe(429);
  });

  it("SSE 路径推断为 low 优先级", () => {
    // SSE 路径 → low 优先级
    // 在低并发时仍通过
    const result = enforceGatewayProtection("GET", "/api/v1/threads/thr_001/events", "req_004", {
      tenantId: "tnt_001",
      userId: "usr_001",
      threadId: "thr_001",
    });
    expect(result.ok).toBe(true);
    result.releaseOverload?.();
  });

  it("取消操作推断为 critical 优先级", () => {
    const result = enforceGatewayProtection("POST", "/api/v1/jobs/job_001:cancel", "req_005", {
      tenantId: "tnt_001",
      userId: "usr_001",
    });
    expect(result.ok).toBe(true);
    result.releaseOverload?.();
  });
});

// ─── 管理端点只读快照 ───────────────────────────────

describe("管理端点只读快照", () => {
  it("TokenBucketRateLimiter.getConfigs 返回各维度配置", () => {
    const limiter = new TokenBucketRateLimiter({
      tenant: { capacity: 500, refillRatePerSecond: 100 },
    });
    const configs = limiter.getConfigs();
    expect(configs.tenant.capacity).toBe(500);
    expect(configs.tenant.refillRatePerSecond).toBe(100);
    // 未覆盖的维度保留默认值
    expect(configs.user.capacity).toBe(200);
    expect(configs.high_cost.capacity).toBe(10);
  });

  it("OverloadProtector.getConfig 返回当前配置", () => {
    const protector = new OverloadProtector({ maxConcurrent: 200 });
    const config = protector.getConfig();
    expect(config.maxConcurrent).toBe(200);
    expect(config.thresholds.critical).toBe(1.0);
    expect(config.thresholds.low).toBe(0.5);
  });

  it("OverloadProtector.getConfig 返回的配置不可变（修改不影响内部状态）", () => {
    const protector = new OverloadProtector({ maxConcurrent: 100 });
    const config = protector.getConfig();
    config.maxConcurrent = 999;
    config.thresholds.critical = 0.1;
    // 内部配置不受影响
    expect(protector.getConfig().maxConcurrent).toBe(100);
    expect(protector.getConfig().thresholds.critical).toBe(1.0);
  });

  it("SSEConnectionQuota.getSnapshot 返回聚合连接数", () => {
    const quota = new SSEConnectionQuota();
    quota.acquire("tnt_001", "usr_001", "thr_001");
    quota.acquire("tnt_001", "usr_002", "thr_002");
    quota.acquire("tnt_002", "usr_003", "thr_003");

    const snapshot = quota.getSnapshot();
    expect(snapshot.totalActive.tenant).toBe(3);
    expect(snapshot.totalActive.user).toBe(3);
    expect(snapshot.totalActive.thread).toBe(3);
    expect(snapshot.uniqueScopes.tenant).toBe(2); // tnt_001, tnt_002
    expect(snapshot.uniqueScopes.user).toBe(3);
    expect(snapshot.uniqueScopes.thread).toBe(3);
  });

  it("SSEConnectionQuota.getSnapshot release 后计数减少", () => {
    const quota = new SSEConnectionQuota();
    quota.acquire("tnt_001", "usr_001", "thr_001");
    quota.acquire("tnt_001", "usr_001", "thr_002");
    quota.release("tnt_001", "usr_001", "thr_001");

    const snapshot = quota.getSnapshot();
    expect(snapshot.totalActive.tenant).toBe(1);
    expect(snapshot.totalActive.user).toBe(1);
    expect(snapshot.totalActive.thread).toBe(1);
    expect(snapshot.uniqueScopes.thread).toBe(1); // thr_002
  });

  it("SSEConnectionQuota.getConfig 返回当前配置", () => {
    const quota = new SSEConnectionQuota({ maxPerTenant: 50, maxPerThread: 5 });
    const config = quota.getConfig();
    expect(config.maxPerTenant).toBe(50);
    expect(config.maxPerUser).toBe(20); // 默认
    expect(config.maxPerThread).toBe(5);
  });

  it("全链路：3 个单例快照可同时采集（管理端点行为模拟）", () => {
    // 模拟 admin 端点采集快照
    const limiter = new TokenBucketRateLimiter();
    const protector = new OverloadProtector({ maxConcurrent: 100 });
    const quota = new SSEConnectionQuota();

    limiter.checkAndConsume("tenant", "tnt_001");
    protector.acquire("normal");
    quota.acquire("tnt_001", "usr_001", "thr_001");

    // 采集快照
    const rlConfigs = limiter.getConfigs();
    const olConfig = protector.getConfig();
    const olCounts = protector.getPriorityCounts();
    const sseConfig = quota.getConfig();
    const sseSnapshot = quota.getSnapshot();

    expect(rlConfigs.tenant.capacity).toBe(1000);
    expect(protector.getConcurrent()).toBe(1);
    expect(olConfig.maxConcurrent).toBe(100);
    expect(olCounts.normal).toBe(1);
    expect(sseConfig.maxPerTenant).toBe(100);
    expect(sseSnapshot.totalActive.tenant).toBe(1);
  });
});
