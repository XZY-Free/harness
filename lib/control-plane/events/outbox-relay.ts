/**
 * Outbox Relay 领域逻辑。
 *
 * 领取语义：FOR UPDATE SKIP LOCKED + 租约 + 指数退避。
 * 永久错误与可重试错误分离。
 * 死信模型：达到 maxAttempts 后进入 deadLetteredAt。
 */

/** 指数退避计算。 */
export function computeOutboxBackoff(
  attemptCount: number,
  baseMs: number,
  maxMs: number,
): Date {
  const delay = Math.min(baseMs * 2 ** attemptCount, maxMs);
  const jitter = Math.random() * 0.2 * delay; // 20% jitter
  return new Date(Date.now() + delay + jitter);
}

/** 错误分类。 */
export function classifyOutboxError(error: unknown): {
  category: "permanent" | "retryable";
  code: string;
  summary: string;
} {
  if (error instanceof Error) {
    // §3.6: 事件合同错误 → 永久性错误（直接进死信，不重试）
    if (error.name === "ControlPlaneEventUnsupportedError") {
      return {
        category: "permanent",
        code: "UNSUPPORTED_EVENT",
        summary: error.message.slice(0, 500),
      };
    }
    // §3.2: 事件合同验证错误 → 永久性错误
    if (error.name === "ControlPlaneEventContractError") {
      return {
        category: "permanent",
        code: "EVENT_CONTRACT_VIOLATION",
        summary: error.message.slice(0, 500),
      };
    }
    // 永久性错误：数据格式问题、不存在的引用
    if (
      error.name === "DataValidationError" ||
      error.message.includes("not found") ||
      error.message.includes("invalid format") ||
      error.message.includes("constraint violation")
    ) {
      return {
        category: "permanent",
        code: "PERMANENT_ERROR",
        summary: error.message.slice(0, 500),
      };
    }
    // 网络超时、临时不可用
    if (
      error.message.includes("timeout") ||
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("503") ||
      error.message.includes("502")
    ) {
      return {
        category: "retryable",
        code: "TRANSIENT_ERROR",
        summary: error.message.slice(0, 500),
      };
    }
  }
  // 保守默认：未知错误视为可重试
  return {
    category: "retryable",
    code: "UNKNOWN_ERROR",
    summary: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  };
}

/** 判断事件是否可领取。 */
export function isOutboxEventClaimable(event: {
  publishedAt: Date | null;
  deadLetteredAt: Date | null;
  nextAttemptAt: Date | null;
  lockExpiresAt: Date | null;
  maxAttempts: number | null;
  attemptCount: number;
}, now: Date, maxAttempts: number): boolean {
  // 已发布
  if (event.publishedAt) return false;
  // 已死信
  if (event.deadLetteredAt) return false;
  // 达到最大尝试次数
  const effectiveMax = event.maxAttempts ?? maxAttempts;
  if (event.attemptCount >= effectiveMax) return false;
  // 尚未到下次尝试时间
  if (event.nextAttemptAt && event.nextAttemptAt > now) return false;
  // 租约未过期
  if (event.lockExpiresAt && event.lockExpiresAt > now) return false;
  return true;
}
