/**
 * Environment 领域的稳定失败类型。
 *
 * 从 `environment-lease-store` 抽出为独立模块：实例规格解析、真实 Backend、
 * PreparedEvidence 构造都需要抛这些错误，但不应该为此把 DB client 拉进依赖图。
 * `environment-lease-store` 继续 re-export，保持既有 import 路径可用。
 */

/**
 * 实例化/实际配置核验失败。`name` 恒为 `EnvironmentComplianceFailed`
 * （对外稳定错误码；具体原因在 message）。
 */
export class EnvironmentComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentComplianceFailed";
  }
}

export class EnvironmentLeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentLeaseConflictError";
  }
}

export class EnvironmentLeaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentLeaseStateError";
  }
}

/**
 * A05：迟到的准备完成发现准备槽已经换手。
 *
 * 语义边界：这不是"环境不合规"，而是本次完成**已经无权提交结论**。旧工作必须丢弃
 * 自己的 Prepared 证据，并且**不得**登记针对该 Lease 的清理义务 —— 实例按稳定
 * `operationId` 复用，它的生命周期属于当前准备者/当前代际；旧完成只是过期观察者，
 * 若在这里登记清理，就会把继任者刚刚建立好的实例真实释放掉。
 */
export class EnvironmentPreparationClaimSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentPreparationClaimSupersededError";
  }
}

/**
 * 真实 Backend 操作（创建/回读/释放）失败。
 *
 * 与 Compliance 的区别：Compliance 表示"实际配置不满足声明策略"（不可重试，
 * 必须在执行前 fail closed）；本错误表示 Backend 事实操作本身出错（可能可重试，
 * 必须登记持久清理工作，不能吞掉 Backend 错误写 released）。
 */
export class EnvironmentInstanceOperationError extends Error {
  constructor(
    message: string,
    public readonly operationKind: "create" | "inspect" | "release" | "query",
  ) {
    super(message);
    this.name = "EnvironmentInstanceOperationError";
  }
}

/** 已登记的实例在真实回读时不存在；允许未激活的 Prepared 候选按原 operation 重建。 */
export class EnvironmentInstanceMissingError extends EnvironmentInstanceOperationError {
  constructor(message: string) {
    super(message, "inspect");
  }
}
