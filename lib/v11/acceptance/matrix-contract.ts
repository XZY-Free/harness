/**
 * S13-W06 全量验收矩阵契约定义。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W06
 *         （逐项验证 63 个 HTTP operation 的成功/鉴权/幂等/并发/错误/审计行为；
 *           逐项验证 91 个持久 Event 的生产者/schema/顺序/重放/投影/SSE 可见性；
 *           逐项验证 49 个错误映射和员工/管理员可恢复动作，不出现未目录化错误正文；
 *           运行 16 个 Runtime 一致性案例，以及 MySQL 集成、实际 Runtime、浏览器、Electron、
 *           故障注入、安全、容量和删除验证）。
 *
 * 设计：
 * - 矩阵分 4 大类：HTTP operation、持久 Event、错误映射、Runtime 一致性。
 * - 每类对应一组维度（dimension），每条契约项 × 每个维度 = 一个验收矩阵项（matrix item）。
 * - 每个矩阵项有唯一 key（如 `POST /v1/threads:success`），便于结果聚合与门禁判定。
 * - 报告包含总体 passed、阻断项清单、按类别汇总、按维度汇总、详细结果。
 * - 门禁：任一 mandatory 维度失败即阻断发布（全部维度默认 mandatory）。
 */

// ─── 矩阵类别 ──────────────────────────────────────────────

/** 验收矩阵类别。 */
export type AcceptanceMatrixCategory =
  | "http_operation"
  | "persistent_event"
  | "error_mapping"
  | "runtime_conformance";

/** 全部矩阵类别。 */
export const ALL_ACCEPTANCE_MATRIX_CATEGORIES: readonly AcceptanceMatrixCategory[] = [
  "http_operation",
  "persistent_event",
  "error_mapping",
  "runtime_conformance",
];

/** 类别中文标签。 */
export const CATEGORY_LABELS: Record<AcceptanceMatrixCategory, string> = {
  http_operation: "HTTP operation",
  persistent_event: "持久 Event",
  error_mapping: "错误映射",
  runtime_conformance: "Runtime 一致性",
};

// ─── HTTP operation 维度 ─────────────────────────────────

/** HTTP operation 验收维度。 */
export type HttpOperationDimension =
  | "success" // 成功：200/2xx 路径
  | "auth" // 鉴权：401/403 拒绝
  | "idempotency" // 幂等：Idempotency-Key 复用
  | "concurrency" // 并发：ETag/乐观锁冲突
  | "error" // 错误：目录化错误码响应
  | "audit"; // 审计：操作落入审计日志

/** 全部 HTTP operation 维度。 */
export const ALL_HTTP_OPERATION_DIMENSIONS: readonly HttpOperationDimension[] = [
  "success",
  "auth",
  "idempotency",
  "concurrency",
  "error",
  "audit",
];

/** 单个 HTTP operation 契约项。 */
export interface HttpOperationContractItem {
  /** 操作 ID（如 `POST /v1/threads`）。 */
  readonly operationId: string;
  /** HTTP 方法。 */
  readonly method: string;
  /** 路径模板。 */
  readonly path: string;
  /** OpenAPI tag。 */
  readonly tag: string;
  /** 是否支持 Idempotency-Key（决定 idempotency 维度是否必跑）。 */
  readonly supportsIdempotency: boolean;
  /** 是否有 ETag/乐观锁（决定 concurrency 维度是否必跑）。 */
  readonly hasOptimisticLock: boolean;
}

// ─── 持久 Event 维度 ─────────────────────────────────────

/** 持久 Event 验收维度。 */
export type PersistentEventDimension =
  | "producer" // 生产者：正确服务发布事件
  | "schema" // schema：符合事件封装 schema
  | "ordering" // 顺序：序列号单调递增、无空洞
  | "replay" // 重放：幂等重放不重复持久化
  | "projection" // 投影：投影器消费后读模型更新
  | "sse"; // SSE 可见性：订阅者可见

/** 全部持久 Event 维度。 */
export const ALL_PERSISTENT_EVENT_DIMENSIONS: readonly PersistentEventDimension[] = [
  "producer",
  "schema",
  "ordering",
  "replay",
  "projection",
  "sse",
];

/** 单个持久 Event 契约项。 */
export interface PersistentEventContractItem {
  /** 事件类型（如 `thread.created`）。 */
  readonly eventType: string;
  /** 事件流。 */
  readonly streams: readonly string[];
  /** schema 版本。 */
  readonly version: number;
  /** 必须引用字段。 */
  readonly requiredRefs: readonly string[];
  /** 是否可跳过投影。 */
  readonly skippableForProjection: boolean;
}

// ─── 错误映射维度 ────────────────────────────────────────

/** 错误映射验收维度。 */
export type ErrorMappingDimension =
  | "cataloged" // 目录化：响应正文使用目录化 code
  | "recoverable"; // 可恢复：员工/管理员可恢复动作明确

/** 全部错误映射维度。 */
export const ALL_ERROR_MAPPING_DIMENSIONS: readonly ErrorMappingDimension[] = [
  "cataloged",
  "recoverable",
];

/** 单个错误映射契约项。 */
export interface ErrorMappingContractItem {
  /** 错误码（如 `ACCESS_DENIED`）。 */
  readonly code: string;
  /** HTTP 状态码。 */
  readonly http: number;
  /** 是否可重试。 */
  readonly retryable: boolean;
  /** 员工可恢复动作描述（可为空）。 */
  readonly employeeRecovery: string | null;
  /** 管理员可恢复动作描述（可为空）。 */
  readonly adminRecovery: string | null;
}

// ─── Runtime 一致性维度 ──────────────────────────────────

/** Runtime 一致性验收维度（每个 case 一项，共 16 项）。 */
export type RuntimeConformanceDimension = "conformance";

/** 全部 Runtime 一致性维度。 */
export const ALL_RUNTIME_CONFORMANCE_DIMENSIONS: readonly RuntimeConformanceDimension[] = [
  "conformance",
];

/** 单个 Runtime 一致性契约项。 */
export interface RuntimeConformanceContractItem {
  /** case ID（如 `dispatch-binds-immutable-config`）。 */
  readonly caseId: string;
  /** 是否 mandatory（mandatory 失败阻断发布）。 */
  readonly mandatory: boolean;
}

// ─── 矩阵项 ──────────────────────────────────────────────

/** 矩阵项统一类型。 */
export interface AcceptanceMatrixItem {
  /** 矩阵项唯一 key（如 `POST /v1/threads:success`、`thread.created:producer`）。 */
  readonly key: string;
  /** 所属类别。 */
  readonly category: AcceptanceMatrixCategory;
  /** 维度名。 */
  readonly dimension: string;
  /** 关联的契约项 ID（operationId / eventType / code / caseId）。 */
  readonly contractItemId: string;
  /** 是否必跑（基于契约特性，如无 Idempotency-Key 的 operation 跳过 idempotency 维度）。 */
  readonly required: boolean;
  /** 是否 mandatory（mandatory 失败阻断发布，默认 true）。 */
  readonly mandatory: boolean;
}

// ─── 验收结果与报告 ──────────────────────────────────────

/** 单个矩阵项验收结果。 */
export interface AcceptanceResult {
  /** 对应矩阵项 key。 */
  readonly key: string;
  /** 类别。 */
  readonly category: AcceptanceMatrixCategory;
  /** 维度。 */
  readonly dimension: string;
  /** 契约项 ID。 */
  readonly contractItemId: string;
  /** 是否通过。 */
  readonly passed: boolean;
  /** 是否 mandatory。 */
  readonly mandatory: boolean;
  /** 是否跳过（required=false 时自动跳过并通过）。 */
  readonly skipped: boolean;
  /** 详细说明（失败时为失败原因）。 */
  readonly details: string;
  /** 验证人/自动用例名。 */
  readonly verifier: string;
  /** 验证耗时（毫秒）。 */
  readonly durationMs: number;
  /** 验证时间戳（ISO）。 */
  readonly timestamp: string;
}

/** 类别汇总。 */
export interface CategorySummary {
  readonly category: AcceptanceMatrixCategory;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly mandatoryFailed: number;
}

/** 维度汇总。 */
export interface DimensionSummary {
  readonly category: AcceptanceMatrixCategory;
  readonly dimension: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

/** 验收报告。 */
export interface AcceptanceReport {
  /** 生成时间戳（ISO）。 */
  readonly generatedAt: string;
  /** 总体是否通过（无 mandatory 失败即通过）。 */
  readonly passed: boolean;
  /** 阻断项（mandatory 失败）清单。 */
  readonly blockingFailures: readonly string[];
  /** 矩阵项总数。 */
  readonly totalItems: number;
  /** 通过数。 */
  readonly passedCount: number;
  /** 失败数。 */
  readonly failedCount: number;
  /** 跳过数。 */
  readonly skippedCount: number;
  /** mandatory 失败数。 */
  readonly mandatoryFailedCount: number;
  /** 按类别汇总。 */
  readonly categorySummaries: readonly CategorySummary[];
  /** 按维度汇总。 */
  readonly dimensionSummaries: readonly DimensionSummary[];
  /** 全部结果。 */
  readonly results: readonly AcceptanceResult[];
}

/** 验收门禁错误。 */
export class AcceptanceGateError extends Error {
  constructor(
    message: string,
    readonly blockingFailures: readonly string[],
    readonly report: AcceptanceReport,
  ) {
    super(message);
    this.name = "AcceptanceGateError";
  }
}
