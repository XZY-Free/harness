/**
 * Runtime Dispatch Retry Policy（Durable Dispatch / Retry Authority 唯一策略源）。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *
 * 职责：
 * - 固定第一版 retry policy：maxDispatchAttempts / 指数 backoff / lease 时长 / 批量 / 轮询间隔。
 * - backoffDelay(attemptCount)：attempt 1→1s、2→2s、3→4s、4→8s、5→terminal（无 jitter，保证确定性可测）。
 * - isTransientDispatchError(err)：统一读取 Runtime 错误的 retryable 分类。
 *
 * 关键约束：
 * - attempt 语义：同一个 retry work（同一个 InvocationAttempt / InvocationCommand）的
 *   HTTP dispatchAttemptCount，不是 attemptNo。
 * - 时钟必须可注入（Worker test 用 fake clock，禁止 monkey patch 全局 Date）。
 * - 不重试 4xx provider reject / protocol schema / correlation mismatch /
 *   unsupported capability / auth invalid / 真实 payload 冲突的 409。
 */

/** 第一版固定策略参数。 */
export const RUNTIME_DISPATCH_RETRY_POLICY = {
  /** 同一 retry work 的最大 HTTP 发起次数（含首次）。 */
  maxDispatchAttempts: 5,
  /** backoff 上限（ms）。 */
  maxDelayMs: 8_000,
  /** dispatch lease 时长（ms）。 */
  leaseDurationMs: 30_000,
  /** Worker 每轮批量。 */
  batchSize: 50,
  /** Worker 轮询间隔（ms）。 */
  workerPollIntervalMs: 1_000,
} as const;

/** 可注入时钟。 */
export type DispatchClock = () => Date;

/** 默认真实时钟。 */
export const realDispatchClock: DispatchClock = () => new Date();

/**
 * 第 attemptCount 次 dispatch 失败后的 backoff 延迟（ms）。
 * attempt 1→1000、2→2000、3→4000、4→8000、≥5→terminal（返回 0，调用方应判耗尽）。
 */
export function backoffDelayMs(attemptCount: number): number {
  const raw = 1_000 * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(raw, RUNTIME_DISPATCH_RETRY_POLICY.maxDelayMs);
}

/**
 * 判断当前 dispatchAttemptCount（已发生的失败次数）之后是否还允许再试。
 * dispatchAttemptCount >= maxDispatchAttempts → false（terminal exhaustion）。
 */
export function isRetryExhausted(dispatchAttemptCount: number): boolean {
  return dispatchAttemptCount >= RUNTIME_DISPATCH_RETRY_POLICY.maxDispatchAttempts;
}

/** 稳定 transient 错误码（只存安全错误码，不存 endpoint/stack/token）。 */
export type TransientDispatchErrorCode = "runtime_network_unavailable" | "runtime_unavailable";

/**
 * 判定错误是否为可 retry 的 transient 错误。
 * 只允许 RuntimeHttpClientError.kind=network 与 HTTP 503（含 Harness Runtime
 * stream_interrupted 语义，由调用方先行归一化为 RuntimeHttpClientError 或传入 skipReason）。
 */
export function isTransientDispatchError(err: unknown): err is { __transient: true } {
  // 结构化判定由调用方完成（RuntimeHttpClientError 在 lib/runtime/errors，
  // 此处避免引入循环依赖，仅提供判定函数签名）。实现见 isTransientRuntimeError。
  return isTransientRuntimeError(err);
}

/**
 * RuntimeHttpClientError 的 transient 判定。
 * 引入位置独立以避免 policy ← errors 反向依赖。
 */
export function isTransientRuntimeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { kind?: unknown; httpStatus?: unknown; retryable?: unknown };
  if (typeof candidate.retryable === "boolean") return candidate.retryable;
  if (candidate.kind === "network") return true;
  if (
    candidate.kind === "http" &&
    typeof candidate.httpStatus === "number" &&
    (candidate.httpStatus === 429 || candidate.httpStatus >= 500)
  ) {
    return true;
  }
  return false;
}
