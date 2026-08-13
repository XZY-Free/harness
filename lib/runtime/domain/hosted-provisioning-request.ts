/**
 * HostedProvisioningRequest — Hosted 异步供应请求领域类型。
 *
 * 第二批核心对象：将 Hosted 供应从用户 Turn 热路径迁入后台工作流。
 * 用户 Turn 发现无 Ready Route 时只幂等创建 ProvisioningRequest，
 * 不执行外部网络调用。Worker 异步执行供应 Saga。
 *
 * : 正式步骤序列：
 * validate_request → ensure_agent_publication → prepare_runtime_revision
 * → verify_runtime_artifact → record_runtime_conformance → publish_runtime_revision
 * → activate_route → await_projection → verify_route → ready
 *
 * : 删除 waiting_external_evidence / waiting_conformance（同步调用不得保留等待状态）。
 */

/** ProvisioningRequest 状态机。: 只保留 6 个有效状态。 */
export const PROVISIONING_STATES = [
  "pending",
  "running",
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

/** 状态转换规则。: 简化状态机。 */
export function isValidProvisioningTransition(
  from: ProvisioningState,
  to: ProvisioningState,
): boolean {
  const ALLOWED: Record<ProvisioningState, ProvisioningState[]> = {
    pending: ["running", "cancelled"],
    running: ["ready", "retryable_failed", "permanent_failed"],
    ready: [],
    retryable_failed: ["pending", "cancelled"], // Worker 可重新领取
    permanent_failed: [],
    cancelled: [],
  };
  return ALLOWED[from].includes(to);
}

/** 判断是否可被 Worker 领取。: 含 running+expired lease（崩溃恢复）。 */
export function isProvisioningClaimable(request: HostedProvisioningRequest, now: Date): boolean {
  if (request.state === "pending" || request.state === "retryable_failed") {
    if (request.leaseExpiresAt && request.leaseExpiresAt > now) return false;
    if (request.nextAttemptAt && request.nextAttemptAt > now) return false;
    return true;
  }
  // : running + expired lease → 崩溃恢复
  if (request.state === "running" && request.leaseExpiresAt && request.leaseExpiresAt <= now) {
    return true;
  }
  return false;
}

/** 计算供应请求的指数退避。 */
export function computeProvisioningBackoff(
  attemptCount: number,
  baseMs = 10_000,
  maxMs = 600_000,
): Date {
  const delay = Math.min(baseMs * 2 ** attemptCount, maxMs);
  return new Date(Date.now() + delay);
}

/** 错误分类。: 含 HostedProvisioningPermanentError。 */
export function classifyProvisioningError(error: unknown): {
  category: "retryable" | "permanent";
  message: string;
} {
  if (error instanceof Error) {
    // /: Hosted 永久错误（REVISION_MISMATCH, ROUTE_ID_MISMATCH, CHECKPOINT_BROKEN）
    if (error.name === "HostedProvisioningPermanentError") {
      return { category: "permanent", message: error.message };
    }
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
