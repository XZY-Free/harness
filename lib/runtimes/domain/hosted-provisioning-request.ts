/**
 * HostedProvisioningRequest — Hosted 异步供应请求领域类型。
 *
 * 第二批核心对象：将 Hosted 供应从用户 Turn 热路径迁入后台工作流。
 * 用户 Turn 发现无 Ready Route 时只幂等创建 ProvisioningRequest，
 * 不执行外部网络调用。Worker 异步执行供应 Saga。
 *
 * §6.3: 工作流步骤名称细化：
 *   start → publishing_agent → publishing_runtime → activating_route → verifying_route → done
 */

/** ProvisioningRequest 状态机。 */
export const PROVISIONING_STATES = [
  "pending",
  "running",
  "waiting_external_evidence",
  "waiting_conformance",
  "ready",
  "retryable_failed",
  "permanent_failed",
  "cancelled",
] as const;
export type ProvisioningState = (typeof PROVISIONING_STATES)[number];

/** HostedProvisioningRequest 领域对象。 */
export interface HostedProvisioningRequest {
  id: string;
  tenantId: string;
  agentId: string;
  agentRevisionId: string;
  routeScopeKey: string;
  desiredRuntimeKey: string;
  state: ProvisioningState;
  currentStep: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 状态转换规则。 */
export function isValidProvisioningTransition(
  from: ProvisioningState,
  to: ProvisioningState,
): boolean {
  const ALLOWED: Record<ProvisioningState, ProvisioningState[]> = {
    pending: ["running", "cancelled"],
    running: [
      "waiting_external_evidence",
      "waiting_conformance",
      "ready",
      "retryable_failed",
      "permanent_failed",
    ],
    waiting_external_evidence: ["running", "retryable_failed", "permanent_failed", "cancelled"],
    waiting_conformance: ["running", "retryable_failed", "permanent_failed", "cancelled"],
    ready: [],
    retryable_failed: ["pending", "cancelled"], // Worker 可重新领取
    permanent_failed: [],
    cancelled: [],
  };
  return ALLOWED[from].includes(to);
}

/** 判断是否可被 Worker 领取。 */
export function isProvisioningClaimable(request: HostedProvisioningRequest, now: Date): boolean {
  if (request.state !== "pending" && request.state !== "retryable_failed") return false;
  if (request.leaseExpiresAt && request.leaseExpiresAt > now) return false;
  if (request.nextAttemptAt && request.nextAttemptAt > now) return false;
  return true;
}

/** 计算供应请求的指数退避。 */
export function computeProvisioningBackoff(
  attemptCount: number,
  baseMs = 10_000,
  maxMs = 600_000,
): Date {
  const delay = Math.min(baseMs * Math.pow(2, attemptCount), maxMs);
  return new Date(Date.now() + delay);
}

/** 错误分类。 */
export function classifyProvisioningError(error: unknown): {
  category: "retryable" | "permanent";
  message: string;
} {
  if (error instanceof Error) {
    // 签名不可信、Artifact 绑定错误 → 永久失败
    if (
      error.name === "ArtifactAttestationFailedError" ||
      error.name === "ArtifactNotVerifiedError" ||
      error.message.includes("invalid signature") ||
      error.message.includes("artifact binding mismatch")
    ) {
      return { category: "permanent", message: error.message };
    }
    // Evidence Service 超时、网络错误 → 可重试
    if (
      error.message.includes("timeout") ||
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("temporary") ||
      error.message.includes("retryable")
    ) {
      return { category: "retryable", message: error.message };
    }
    // 默认可重试（保守策略）
    return { category: "retryable", message: error.message };
  }
  return { category: "retryable", message: String(error) };
}
