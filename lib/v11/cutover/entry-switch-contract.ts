/**
 * S13-W05 切换通道与验证项契约定义。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W05
 *         （Gateway 将员工 API、Admin API、Runtime Event Ingress 和命令通道切到 V11；
 *           Web、Desktop、Studio 使用 V11 OpenAPI、Event 和错误目录，不保留旧字段兜底；
 *           DeploymentRoute 只指向已通过 conformance、健康、容量和安全门禁的 RuntimeRevision；
 *           切换后立即验证创建 Thread、连续 Turn、Tool/Effect、Desktop、本地授权、Child、Job、管理发布和 Trace）。
 *
 * 设计：
 * - 定义 4 个切换通道（员工 API、Admin API、Runtime Event Ingress、命令通道）。
 * - 定义 3 个产品入口（Web、Desktop、Studio）。
 * - 定义 9 项切换后立即验证项。
 * - 扩展 V11EntryOpener 接口为完整的切换契约。
 */
import type { CutoverSession } from "@/lib/v11/cutover/session-store";

// ─── 切换通道 ──────────────────────────────────────────────

/** V11 切换通道类型。 */
export type CutoverChannel =
  | "employee_api" // 员工 API（Gateway → V11 员工 API）
  | "admin_api" // 管理后台 API（Gateway → V11 Admin API）
  | "runtime_event_ingress" // Runtime Event Ingress（Runtime → V11 Event Ingress）
  | "command_channel"; // 命令通道（Steer/Cancel/Resume → V11 Command Dispatcher）

/** 全部切换通道。 */
export const ALL_CUTOVER_CHANNELS: readonly CutoverChannel[] = [
  "employee_api",
  "admin_api",
  "runtime_event_ingress",
  "command_channel",
];

/** 单个通道切换状态。 */
export interface ChannelSwitchStatus {
  readonly channel: CutoverChannel;
  /** 是否已切到 V11。 */
  readonly switched: boolean;
  /** 切换时间（ISO 字符串）。 */
  readonly switchedAt: string | null;
  /** 切换操作人。 */
  readonly switchedBy: string | null;
  /** 关联会话 ID。 */
  readonly sessionId: string | null;
  /** 旧入口是否已冻结（切换前置条件）。 */
  readonly legacyFrozen: boolean;
}

// ─── 产品入口 ──────────────────────────────────────────────

/** V11 产品入口类型。 */
export type ProductEntry =
  | "web" // Web 员工端
  | "desktop" // Desktop（Electron）
  | "studio"; // Studio 管理后台

/** 全部产品入口。 */
export const ALL_PRODUCT_ENTRIES: readonly ProductEntry[] = ["web", "desktop", "studio"];

/** 单个产品入口切换状态。 */
export interface ProductEntrySwitchStatus {
  readonly entry: ProductEntry;
  /** 是否已切到 V11 OpenAPI/Event/错误目录。 */
  readonly switched: boolean;
  /** 是否仍保留旧字段兜底（S13-W05 要求不保留）。 */
  readonly legacyFallbackEnabled: boolean;
  readonly switchedAt: string | null;
  readonly sessionId: string | null;
}

// ─── 切换后立即验证项 ──────────────────────────────────────

/** V11 切换后立即验证项类型。 */
export type PostCutoverVerificationType =
  | "create_thread" // 创建 Thread
  | "consecutive_turns" // 连续 Turn
  | "tool_effect" // Tool/Effect
  | "desktop" // Desktop
  | "local_authorization" // 本地授权
  | "child_thread" // Child Thread
  | "job" // Job
  | "admin_publish" // 管理发布
  | "trace"; // Trace

/** 全部切换后验证项。 */
export const ALL_POST_CUTOVER_VERIFICATIONS: readonly PostCutoverVerificationType[] = [
  "create_thread",
  "consecutive_turns",
  "tool_effect",
  "desktop",
  "local_authorization",
  "child_thread",
  "job",
  "admin_publish",
  "trace",
];

/** 单项验证结果。 */
export interface PostCutoverVerificationResult {
  readonly type: PostCutoverVerificationType;
  readonly passed: boolean;
  readonly details: string;
  /** 验证产生的 V11 资源 ID（如 Thread ID、Turn ID 等，用于审计追溯）。 */
  readonly resourceId: string | null;
  readonly timestamp: string;
  /** 验证耗时（毫秒）。 */
  readonly durationMs: number;
}

/** 切换后验证汇总报告。 */
export interface PostCutoverVerificationReport {
  readonly sessionId: string;
  readonly results: readonly PostCutoverVerificationResult[];
  readonly passedCount: number;
  readonly failedCount: number;
  readonly passed: boolean;
  readonly failedVerifications: readonly string[];
  readonly generatedAt: string;
}

// ─── DeploymentRoute 门禁校验 ──────────────────────────────

/** DeploymentRoute 门禁检查维度。 */
export type DeploymentRouteGateDimension =
  | "conformance" // RuntimeRevision 通过 conformance 校验
  | "health" // RuntimeRevision 健康检查通过
  | "capacity" // RuntimeRevision 容量门禁通过
  | "security"; // RuntimeRevision 安全门禁通过

/** 全部门禁维度。 */
export const ALL_DEPLOYMENT_ROUTE_GATES: readonly DeploymentRouteGateDimension[] = [
  "conformance",
  "health",
  "capacity",
  "security",
];

/** 单个门禁检查结果。 */
export interface DeploymentRouteGateResult {
  readonly dimension: DeploymentRouteGateDimension;
  readonly passed: boolean;
  readonly details: string;
  readonly runtimeRevisionId: string;
}

/** DeploymentRoute 门禁汇总结果。 */
export interface DeploymentRouteGateReport {
  readonly deploymentRouteId: string;
  readonly agentId: string;
  readonly runtimeRevisionId: string;
  readonly gateResults: readonly DeploymentRouteGateResult[];
  readonly passed: boolean;
  readonly failedGates: readonly string[];
}

// ─── 扩展的 V11 入口开放器接口 ──────────────────────────

/**
 * 扩展的 V11 入口开放器接口（S13-W05）。
 *
 * 覆盖：
 * - 4 个切换通道（员工 API、Admin API、Runtime Event Ingress、命令通道）
 * - 3 个产品入口（Web、Desktop、Studio）
 * - DeploymentRoute 门禁校验
 * - 切换后 9 项立即验证
 */
export interface V11EntrySwitcher {
  /** 校验 DeploymentRoute 门禁（切换前调用）。 */
  verifyDeploymentRouteGates(session: CutoverSession): Promise<DeploymentRouteGateReport>;

  /** 切换指定通道到 V11。 */
  switchChannel(channel: CutoverChannel, session: CutoverSession, operator: string): Promise<void>;

  /** 批量切换所有通道到 V11。 */
  switchAllChannels(session: CutoverSession, operator: string): Promise<void>;

  /** 切换指定产品入口到 V11（禁用旧字段兜底）。 */
  switchProductEntry(entry: ProductEntry, session: CutoverSession, operator: string): Promise<void>;

  /** 批量切换所有产品入口到 V11。 */
  switchAllProductEntries(session: CutoverSession, operator: string): Promise<void>;

  /** 查询通道切换状态。 */
  getChannelStatus(channel: CutoverChannel): ChannelSwitchStatus;

  /** 查询全部通道切换状态。 */
  getAllChannelStatuses(): readonly ChannelSwitchStatus[];

  /** 查询产品入口切换状态。 */
  getProductEntryStatus(entry: ProductEntry): ProductEntrySwitchStatus;

  /** 查询全部产品入口切换状态。 */
  getAllProductEntryStatuses(): readonly ProductEntrySwitchStatus[];

  /** 检查是否全部通道已切换。 */
  isAllChannelsSwitched(): boolean;

  /** 检查是否全部产品入口已切换且无旧字段兜底。 */
  isAllProductEntriesSwitched(): boolean;

  /** 执行切换后立即验证（9 项）。 */
  runPostCutoverVerifications(session: CutoverSession): Promise<PostCutoverVerificationReport>;

  /**
   * 完整切换入口（编排器调用）。
   * 包含：门禁校验 → 切换通道 → 切换产品入口 → 切换后验证。
   */
  openV11Entry(sessionId: string): Promise<PostCutoverVerificationReport>;
}
