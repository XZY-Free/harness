/**
 * S13-W07 旧路径与兼容层删除契约定义。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W07
 *         （切换稳定并满足回滚观察窗口后，删除旧 Message/Run/Transcript/Subagent/BackgroundTask 写路径；
 *           删除旧 API、客户端字段、事件猜测、双轨状态 reducer 和旧 Runtime 入口；
 *           旧表先停止读写并保留受控归档，达到批准条件后再通过独立迁移删除；
 *           不在切换提交里直接破坏回滚点；删除后再次全文检索旧对象引用并运行全部验收）。
 *
 * 设计：
 * - 删除项分 5 大类：legacy_write_path、legacy_api、legacy_client、legacy_runtime、legacy_table。
 * - 每个删除项有唯一 key、依赖关系、删除前检查、删除后验证。
 * - 删除前必须通过依赖检查（无活跃引用）和切换稳定观察窗口检查。
 * - 旧表删除分两阶段：先归档（停止读写 + 受控归档），后批准删除（满足条件后独立迁移）。
 * - 删除后执行全文检索验证，确保无暗中依赖旧对象。
 */
import type { CutoverSession } from "@/lib/v11/cutover/session-store";

// ─── 删除类别 ──────────────────────────────────────────────

/** 删除项类别。 */
export type LegacyRemovalCategory =
  | "legacy_write_path" // 旧写路径（Message/Run/Transcript/Subagent/BackgroundTask 写入）
  | "legacy_api" // 旧 API 路由
  | "legacy_client" // 旧客户端字段、事件猜测、双轨状态 reducer
  | "legacy_runtime" // 旧 Runtime 入口
  | "legacy_table"; // 旧表（先归档后删除）

/** 全部删除类别。 */
export const ALL_LEGACY_REMOVAL_CATEGORIES: readonly LegacyRemovalCategory[] = [
  "legacy_write_path",
  "legacy_api",
  "legacy_client",
  "legacy_runtime",
  "legacy_table",
];

/** 类别中文标签。 */
export const REMOVAL_CATEGORY_LABELS: Record<LegacyRemovalCategory, string> = {
  legacy_write_path: "旧写路径",
  legacy_api: "旧 API",
  legacy_client: "旧客户端/事件猜测/双轨 reducer",
  legacy_runtime: "旧 Runtime 入口",
  legacy_table: "旧表归档与删除",
};

// ─── 删除项 ────────────────────────────────────────────────

/** 删除项状态。 */
export type RemovalItemStatus =
  | "pending" // 待删除
  | "archived" // 已归档（仅 legacy_table 类别）
  | "removal_ready" // 满足删除条件
  | "removed" // 已删除
  | "blocked"; // 阻断（有活跃依赖或前置检查未通过）

/** 单个删除项。 */
export interface LegacyRemovalItem {
  /** 唯一 key（如 `write_path:Message`、`api:/v1/legacy/messages`、`table:Message`）。 */
  readonly key: string;
  /** 类别。 */
  readonly category: LegacyRemovalCategory;
  /** 旧对象名（如表名、API 路径、客户端字段名）。 */
  readonly objectName: string;
  /** 关联的旧表物理名（legacy_table 必填，其他类别可空）。 */
  readonly physicalTable: string | null;
  /** 前置依赖项 key（必须先完成的删除项）。 */
  readonly dependsOn: readonly string[];
  /** 是否需要归档阶段（仅 legacy_table 为 true）。 */
  readonly requiresArchive: boolean;
  /** 删除批准条件描述（满足后才允许删除）。 */
  readonly approvalConditions: readonly string[];
  /** 当前状态。 */
  readonly status: RemovalItemStatus;
  /** 归档时间戳（archived 后非空）。 */
  readonly archivedAt: string | null;
  /** 删除时间戳（removed 后非空）。 */
  readonly removedAt: string | null;
  /** 阻断原因（blocked 时非空）。 */
  readonly blockedReason: string | null;
}

// ─── 依赖检查 ──────────────────────────────────────────────

/** 依赖检查结果。 */
export interface DependencyCheckResult {
  /** 删除项 key。 */
  readonly itemKey: string;
  /** 是否有活跃引用（true 表示阻断删除）。 */
  readonly hasActiveReferences: boolean;
  /** 引用位置列表（文件路径:行号）。 */
  readonly references: readonly string[];
  /** 检查时间戳。 */
  readonly timestamp: string;
}

// ─── 删除报告 ──────────────────────────────────────────────

/** 单个删除项的执行结果。 */
export interface RemovalResult {
  /** 删除项 key。 */
  readonly key: string;
  /** 类别。 */
  readonly category: LegacyRemovalCategory;
  /** 是否成功。 */
  readonly success: boolean;
  /** 操作类型（archive/remove/verify）。 */
  readonly operation: "archive" | "remove" | "verify";
  /** 详细说明。 */
  readonly details: string;
  /** 执行时间戳。 */
  readonly timestamp: string;
}

/** 删除报告。 */
export interface LegacyRemovalReport {
  /** 生成时间戳。 */
  readonly generatedAt: string;
  /** 总体是否通过（全部删除项 removed 且无活跃引用）。 */
  readonly passed: boolean;
  /** 阻断项清单。 */
  readonly blockingItems: readonly string[];
  /** 删除项总数。 */
  readonly totalItems: number;
  /** 已删除数。 */
  readonly removedCount: number;
  /** 已归档数。 */
  readonly archivedCount: number;
  /** 待处理数。 */
  readonly pendingCount: number;
  /** 阻断数。 */
  readonly blockedCount: number;
  /** 按类别汇总。 */
  readonly categorySummaries: readonly LegacyRemovalCategorySummary[];
  /** 全部删除结果。 */
  readonly results: readonly RemovalResult[];
  /** 全文检索验证结果。 */
  readonly referenceScan: LegacyReferenceScanReport;
}

/** 类别汇总。 */
export interface LegacyRemovalCategorySummary {
  readonly category: LegacyRemovalCategory;
  readonly total: number;
  readonly removed: number;
  readonly archived: number;
  readonly pending: number;
  readonly blocked: number;
}

/** 全文检索扫描报告。 */
export interface LegacyReferenceScanReport {
  /** 扫描时间戳。 */
  readonly scannedAt: string;
  /** 是否通过（无活跃旧对象引用）。 */
  readonly passed: boolean;
  /** 扫描的文件数。 */
  readonly scannedFiles: number;
  /** 残留引用数。 */
  readonly residualReferences: number;
  /** 残留引用详情（按对象名分组）。 */
  readonly residualByObject: readonly { readonly objectName: string; readonly count: number }[];
}

// ─── 删除执行错误 ──────────────────────────────────────────

/** 旧路径删除错误。 */
export class LegacyRemovalError extends Error {
  constructor(
    message: string,
    readonly itemKey: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "LegacyRemovalError";
  }
}

/** 删除门禁错误（存在未删除或阻断项时抛出）。 */
export class LegacyRemovalGateError extends Error {
  constructor(
    message: string,
    readonly blockingItems: readonly string[],
    readonly report: LegacyRemovalReport,
  ) {
    super(message);
    this.name = "LegacyRemovalGateError";
  }
}

// ─── 切换稳定观察窗口检查 ──────────────────────────────────

/** 切换稳定观察窗口检查结果。 */
export interface CutoverStabilityCheckResult {
  /** 是否满足删除前置条件（切换已完成且观察窗口已过）。 */
  readonly passed: boolean;
  /** 切换会话 ID。 */
  readonly sessionId: string | null;
  /** 切换完成时间戳。 */
  readonly cutoverCompletedAt: string | null;
  /** 观察窗口结束时间戳（cutoverCompletedAt + observationWindowMs）。 */
  readonly observationWindowEndsAt: string | null;
  /** 当前时间戳。 */
  readonly checkedAt: string;
  /** 失败原因。 */
  readonly reason: string | null;
}

/** 切换稳定观察窗口检查器接口。 */
export interface CutoverStabilityChecker {
  /** 检查切换是否稳定且观察窗口已过。 */
  checkStability(session: CutoverSession | null): Promise<CutoverStabilityCheckResult>;
}
