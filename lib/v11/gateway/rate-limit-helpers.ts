/**
 * V11 限流与过载保护路由助手（S12-W02）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/14-production-operations-security-and-retention.md §2.2
 * - ../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md S12-W02
 *
 * 职责：
 * - 构建 RATE_LIMITED (429) 响应，包含 retry_after_ms 和 Retry-After 头。
 * - 构建 STREAM_BACKPRESSURE (429) 响应，包含连接配额信息。
 * - 构建 RUNTIME_UNAVAILABLE (503) 响应，用于过载拒绝。
 * - 提供统一的限流+过载检查入口，供 route handler 在业务逻辑前调用。
 *
 * 关键约束：
 * - 不伪造成功响应：被限流/过载的请求必须返回 429 或 503。
 * - Retry-After 头使用秒级整数（HTTP 标准），details.retry_after_ms 使用毫秒（机器友好）。
 * - 过载保护 acquire/release 必须配对；enforceGatewayProtection 返回 ok 时附带回滚函数。
 */
import { REQUEST_ID_HEADER, v11Error } from "@/lib/http";
import type { V11ErrorCode } from "@/lib/v11/error-codes";
import {
  type OverloadResult,
  type RequestPriority,
  getOverloadProtector,
  inferPriority,
} from "@/lib/v11/gateway/overload-protection";
import {
  type RateLimitResult,
  type RateLimitScopeType,
  getRateLimiter,
} from "@/lib/v11/gateway/rate-limiter";
import type { SSEQuotaResult } from "@/lib/v11/gateway/sse-connection-quota";
import type { V11Principal } from "@/lib/v11/identity/resolver";

/** 限流检查请求参数。 */
export interface RateLimitCheckParams {
  /** 租户 ID。 */
  tenantId: string;
  /** 用户 ID（员工 API 必填；Gateway API 可为 runtimeId）。 */
  userId?: string;
  /** Thread ID（Thread 级限流时必填）。 */
  threadId?: string;
  /** Runtime ID（Gateway API 级限流时必填）。 */
  runtimeId?: string;
  /** 是否高成本操作（导出、重建等）。 */
  highCost?: boolean;
  /** 消耗令牌数（默认 1）。 */
  cost?: number;
}

/** 限流检查结果。 */
export interface GatewayProtectionResult {
  /** 是否放行。 */
  ok: boolean;
  /** 被拒绝时的 HTTP 响应。 */
  response: Response | null;
  /** 过载保护释放函数（ok=true 时必填，请求结束后调用）。 */
  releaseOverload: (() => void) | null;
}

/**
 * 执行限流 + 过载保护检查。
 *
 * 调用方在业务逻辑前调用此函数：
 * - ok=false → 直接返回 response（429 或 503）
 * - ok=true → 执行业务，结束后调用 releaseOverload()
 *
 * @param method HTTP 方法
 * @param path 请求路径
 * @param requestId 请求 ID
 * @param params 限流参数
 * @returns 保护检查结果
 */
export function enforceGatewayProtection(
  method: string,
  path: string,
  requestId: string,
  params: RateLimitCheckParams,
): GatewayProtectionResult {
  // 1. 过载保护检查（按优先级）
  const priority = inferPriority(method, path);
  const protector = getOverloadProtector();
  const overloadResult = protector.acquire(priority);

  if (!overloadResult.allowed) {
    return {
      ok: false,
      response: buildOverloadResponse(overloadResult, requestId),
      releaseOverload: null,
    };
  }

  // 2. 限流检查（多维度批量）
  const scopes: Array<{ scopeType: RateLimitScopeType; scopeId: string; cost?: number }> = [
    { scopeType: "tenant", scopeId: params.tenantId, cost: params.cost },
  ];
  if (params.userId) {
    scopes.push({ scopeType: "user", scopeId: params.userId, cost: params.cost });
  }
  if (params.threadId) {
    scopes.push({ scopeType: "thread", scopeId: params.threadId, cost: params.cost });
  }
  if (params.runtimeId) {
    scopes.push({ scopeType: "runtime", scopeId: params.runtimeId, cost: params.cost });
  }
  if (params.highCost) {
    scopes.push({ scopeType: "high_cost", scopeId: params.tenantId, cost: params.cost ?? 5 });
  }

  const limiter = getRateLimiter();
  const rateLimitResult = limiter.checkAndConsumeBatch(scopes);

  if (!rateLimitResult.allowed) {
    // 限流拒绝：释放过载槽位（因为不执行业务）
    protector.release(priority);
    return {
      ok: false,
      response: buildRateLimitResponse(rateLimitResult, requestId),
      releaseOverload: null,
    };
  }

  // 3. 全部通过
  return {
    ok: true,
    response: null,
    releaseOverload: () => protector.release(priority),
  };
}

/**
 * 构建 RATE_LIMITED (429) 响应。
 *
 * 包含：
 * - Retry-After 头（秒级整数，HTTP 标准）
 * - details.retry_after_ms（毫秒，机器友好）
 * - details.scope（被限流维度）
 * - details.remaining（剩余令牌）
 * - details.limit（桶容量）
 */
export function buildRateLimitResponse(result: RateLimitResult, requestId: string): Response {
  const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
  const body = {
    error: {
      code: "RATE_LIMITED" as V11ErrorCode,
      message: `请求被限流：维度 ${result.scopeType}（${result.scopeKey}）令牌不足，${result.retryAfterMs}ms 后可重试`,
      request_id: requestId,
      retryable: true,
      details: {
        scope: result.scopeType,
        scope_key: result.scopeKey,
        retry_after_ms: result.retryAfterMs,
        remaining: result.remaining,
        limit: result.limit,
      },
    },
  };
  return Response.json(body, {
    status: 429,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

/**
 * 构建 STREAM_BACKPRESSURE (429) 响应。
 *
 * 用于 SSE 连接配额超限。
 *
 * 包含：
 * - Retry-After 头
 * - details.retry_after_ms
 * - details.scope（tenant/user/thread）
 * - details.active（当前活跃连接数）
 * - details.max（最大连接数）
 */
export function buildStreamBackpressureResponse(
  result: SSEQuotaResult,
  requestId: string,
): Response {
  const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
  const body = {
    error: {
      code: "STREAM_BACKPRESSURE" as V11ErrorCode,
      message: `SSE 连接配额超限：维度 ${result.scope}（活跃 ${result.active}/${result.max}），${result.retryAfterMs}ms 后可重试`,
      request_id: requestId,
      retryable: true,
      details: {
        scope: result.scope,
        retry_after_ms: result.retryAfterMs,
        active: result.active,
        max: result.max,
      },
    },
  };
  return Response.json(body, {
    status: 429,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

/**
 * 构建过载拒绝响应。
 *
 * 过载使用 503 RUNTIME_UNAVAILABLE（区分限流的 429）。
 * 但如果只是优先级阈值触发（非绝对上限），使用 429 RATE_LIMITED 更合适。
 */
export function buildOverloadResponse(result: OverloadResult, requestId: string): Response {
  // 绝对上限触发 → 503
  if (result.reason === "max_concurrent_reached") {
    return v11Error(
      "RUNTIME_UNAVAILABLE",
      `服务过载：并发已达上限 ${result.maxConcurrent}，请稍后重试`,
      {
        requestId,
        details: {
          reason: result.reason,
          concurrent: result.concurrent,
          max_concurrent: result.maxConcurrent,
          retry_after_ms: result.retryAfterMs,
        },
      },
    );
  }

  // 优先级阈值触发 → 429
  const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
  const body = {
    error: {
      code: "RATE_LIMITED" as V11ErrorCode,
      message: `请求被降级：优先级 ${result.priority} 在过载期间被拒绝（并发 ${result.concurrent}/${result.maxConcurrent}）`,
      request_id: requestId,
      retryable: true,
      details: {
        reason: result.reason,
        priority: result.priority,
        concurrent: result.concurrent,
        max_concurrent: result.maxConcurrent,
        retry_after_ms: result.retryAfterMs,
      },
    },
  };
  return Response.json(body, {
    status: 429,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

/**
 * 从员工 Principal 提取限流参数。
 */
export function rateLimitParamsFromPrincipal(
  principal: V11Principal,
  options?: {
    threadId?: string;
    highCost?: boolean;
    cost?: number;
  },
): RateLimitCheckParams {
  return {
    tenantId: principal.tenantId,
    userId: principal.userIdentityId,
    threadId: options?.threadId,
    highCost: options?.highCost,
    cost: options?.cost,
  };
}

/**
 * 创建过载保护守卫（用于需要手动管理生命周期的场景）。
 *
 * 返回 [ok, response, release] 元组：
 * - ok=false → 返回 response，不需要 release
 * - ok=true → 执行业务后调用 release
 */
export function acquireOverloadGuard(
  priority: RequestPriority,
  requestId: string,
): [boolean, Response | null, (() => void) | null] {
  const protector = getOverloadProtector();
  const result = protector.acquire(priority);
  if (!result.allowed) {
    return [false, buildOverloadResponse(result, requestId), null];
  }
  return [true, null, () => protector.release(priority)];
}
