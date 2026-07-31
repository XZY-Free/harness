/**
 * S13-W08 发布、值守与移交契约定义。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W08
 *         （发布记录包含方案版本、制品摘要、迁移批次、配置、已知限制、回滚点和负责人；
 *           观察窗口跟踪 API/SSE、Invocation、unknown Effect、Job、Desktop、Trace、成本容量和安全告警；
 *           事故操作按阶段 12 的隔离与处置执行，不以修改数据库终态作为常规恢复手段；
 *           运维手册只描述当前可运行 V11，不把已删除旧路径或未来设想混入正式手册）。
 *
 * 设计：
 * - 4 大模块：发布记录（ReleaseRecord）、观察窗口（ObservationWindow）、
 *   事故处置（IncidentOperation）、运维手册（OperationsRunbook）。
 * - 每个模块有独立的生成器与门禁判定。
 * - 发布记录门禁：必填字段齐全 + 制品摘要完整 + 回滚点明确 + 负责人非空。
 * - 观察窗口门禁：8 类指标全部采集 + 无异常或异常已处置。
 * - 运维手册门禁：不包含旧路径关键词 + 不包含未来设想关键词 + 仅描述 V11。
 */

// ─── 发布记录 ──────────────────────────────────────────────

/** V11 方案版本。 */
export const V11_SCHEME_VERSION = "11.0.0" as const;

/** 发布记录必填字段。 */
export interface ReleaseRecord {
  /** 方案版本（如 "11.0.0"）。 */
  readonly schemeVersion: string;
  /** 发布时间戳（ISO）。 */
  readonly releasedAt: string;
  /** 制品摘要（镜像/包名/版本/哈希）。 */
  readonly artifactSummary: readonly ArtifactDescriptor[];
  /** 迁移批次记录（每批次的域、记录数、状态）。 */
  readonly migrationBatches: readonly MigrationBatchRecord[];
  /** 配置快照（环境变量/特性开关/路由配置的关键键值）。 */
  readonly configSnapshot: readonly ConfigEntry[];
  /** 已知限制清单。 */
  readonly knownLimitations: readonly string[];
  /** 回滚点描述（恢复点位置、触发条件、责任人）。 */
  readonly rollbackPoint: RollbackPointDescriptor;
  /** 负责人（发布负责人）。 */
  readonly owner: string;
  /** 值值守卫名单（on-call）。 */
  readonly oncallRoster: readonly string[];
  /** 发布说明（自由文本）。 */
  readonly releaseNotes: string;
}

/** 制品描述符。 */
export interface ArtifactDescriptor {
  /** 制品名（如 "snow-harness-api"）。 */
  readonly name: string;
  /** 版本（如 "11.0.0"）。 */
  readonly version: string;
  /** 类型（image/package/binary）。 */
  readonly type: "image" | "package" | "binary";
  /** 摘要/哈希（如 sha256:...）。 */
  readonly digest: string;
}

/** 迁移批次记录。 */
export interface MigrationBatchRecord {
  /** 批次 ID。 */
  readonly batchId: string;
  /** 迁移域。 */
  readonly domain: string;
  /** 迁移记录数。 */
  readonly recordCount: number;
  /** 批次状态。 */
  readonly status: "completed" | "partial" | "failed";
  /** 完成时间戳。 */
  readonly completedAt: string;
}

/** 配置项。 */
export interface ConfigEntry {
  /** 配置键。 */
  readonly key: string;
  /** 配置值（脱敏后）。 */
  readonly value: string;
  /** 是否敏感（true 时值脱敏）。 */
  readonly sensitive: boolean;
}

/** 回滚点描述符。 */
export interface RollbackPointDescriptor {
  /** 恢复点位置（如备份文件路径/快照 ID）。 */
  readonly location: string;
  /** 触发条件描述。 */
  readonly triggerConditions: readonly string[];
  /** 责任人。 */
  readonly owner: string;
  /** 创建时间戳。 */
  readonly createdAt: string;
}

/** 发布记录门禁错误。 */
export class ReleaseRecordGateError extends Error {
  constructor(
    message: string,
    readonly missingFields: readonly string[],
  ) {
    super(message);
    this.name = "ReleaseRecordGateError";
  }
}

// ─── 观察窗口 ──────────────────────────────────────────────

/** 观察指标类别（8 类，来自 S13-W08 要求）。 */
export type ObservationMetricCategory =
  | "api" // API 成功率/延迟/错误率
  | "sse" // SSE 连接数/断开/重连
  | "invocation" // Invocation 状态分布/时长
  | "unknown_effect" // unknown Effect 计数
  | "job" // Job 状态/失败率
  | "desktop" // Desktop 连接/ownership 变更
  | "trace" // Trace 采样/_span 数
  | "cost_capacity" // 成本容量（token/CPU/内存）
  | "security_alert"; // 安全告警

/** 全部观察指标类别。 */
export const ALL_OBSERVATION_METRIC_CATEGORIES: readonly ObservationMetricCategory[] = [
  "api",
  "sse",
  "invocation",
  "unknown_effect",
  "job",
  "desktop",
  "trace",
  "cost_capacity",
  "security_alert",
];

/** 单个指标采集结果。 */
export interface MetricSample {
  /** 类别。 */
  readonly category: ObservationMetricCategory;
  /** 指标名（如 "api.error_rate"）。 */
  readonly name: string;
  /** 数值。 */
  readonly value: number;
  /** 单位（如 "%"、"ms"、"count"）。 */
  readonly unit: string;
  /** 是否异常（超出阈值）。 */
  readonly anomalous: boolean;
  /** 采集时间戳。 */
  readonly timestamp: string;
  /** 详细说明（异常时为原因）。 */
  readonly details: string;
}

/** 观察窗口报告。 */
export interface ObservationWindowReport {
  /** 窗口开始时间戳。 */
  readonly windowStart: string;
  /** 窗口结束时间戳。 */
  readonly windowEnd: string;
  /** 是否全部正常（无异常或异常已处置）。 */
  readonly passed: boolean;
  /** 异常指标数。 */
  readonly anomalousCount: number;
  /** 已处置异常数。 */
  readonly resolvedCount: number;
  /** 未处置异常数。 */
  readonly unresolvedCount: number;
  /** 按类别汇总。 */
  readonly categorySummaries: readonly ObservationCategorySummary[];
  /** 全部指标采样。 */
  readonly samples: readonly MetricSample[];
  /** 异常处置记录。 */
  readonly incidentOperations: readonly IncidentOperationRecord[];
}

/** 类别汇总。 */
export interface ObservationCategorySummary {
  readonly category: ObservationMetricCategory;
  readonly sampleCount: number;
  readonly anomalousCount: number;
}

/** 观察窗口门禁错误。 */
export class ObservationWindowGateError extends Error {
  constructor(
    message: string,
    readonly unresolvedAnomalies: readonly string[],
    readonly report: ObservationWindowReport,
  ) {
    super(message);
    this.name = "ObservationWindowGateError";
  }
}

// ─── 事故处置 ──────────────────────────────────────────────

/** 事故处置动作类型（来自阶段 12 隔离与处置）。 */
export type IncidentActionType =
  | "isolate" // 隔离异常组件
  | "throttle" // 限流降级
  | "reroute" // 切换流量
  | "pause_job" // 暂停 Job
  | "rotate_credential" // 轮换凭证
  | "notify" // 通知值守
  | "escalate"; // 升级处置

/** 事故处置记录。 */
export interface IncidentOperationRecord {
  /** 事故 ID。 */
  readonly incidentId: string;
  /** 关联的指标类别。 */
  readonly metricCategory: ObservationMetricCategory;
  /** 处置动作类型。 */
  readonly actionType: IncidentActionType;
  /** 是否已处置。 */
  readonly resolved: boolean;
  /** 处置人。 */
  readonly operator: string;
  /** 处置时间戳。 */
  readonly operatedAt: string;
  /** 处置说明。 */
  readonly details: string;
  /** 是否以修改数据库终态作为恢复手段（必须为 false）。 */
  readonly modifiesDatabaseTerminalState: boolean;
}

/** 事故处置错误（违反"不以修改数据库终态作为常规恢复手段"约束）。 */
export class IncidentOperationError extends Error {
  constructor(
    message: string,
    readonly incidentId: string,
    readonly violation: string,
  ) {
    super(message);
    this.name = "IncidentOperationError";
  }
}

// ─── 运维手册 ──────────────────────────────────────────────

/** 运维手册章节。 */
export interface RunbookSection {
  /** 章节标题。 */
  readonly title: string;
  /** 章节内容（Markdown）。 */
  readonly content: string;
  /** 章节顺序。 */
  readonly order: number;
}

/** 运维手册。 */
export interface OperationsRunbook {
  /** 手册版本（与方案版本一致）。 */
  readonly version: string;
  /** 生成时间戳。 */
  readonly generatedAt: string;
  /** 适用范围（仅 V11）。 */
  readonly scope: string;
  /** 章节列表。 */
  readonly sections: readonly RunbookSection[];
  /** 生成文本（Markdown 全文）。 */
  readonly markdown: string;
}

/** 运维手册门禁错误（包含旧路径或未来设想）。 */
export class RunbookGateError extends Error {
  constructor(
    message: string,
    readonly violations: readonly string[],
    readonly runbook: OperationsRunbook,
  ) {
    super(message);
    this.name = "RunbookGateError";
  }
}

/**
 * 运维手册禁止关键词（旧路径 + 未来设想）。
 *
 * 来自 S13-W08："运维手册只描述当前可运行 V11，不把已删除旧路径或未来设想混入正式手册"。
 */
export const RUNBOOK_FORBIDDEN_KEYWORDS = [
  // 旧路径关键词
  "Message 表",
  "ThreadRun 表",
  "ToolRun 表",
  "RunTranscriptChunk",
  "SubagentDefinition",
  "SubagentRun",
  "BackgroundTask 表",
  "旧 API",
  "旧 Runtime",
  "双轨",
  "兼容层",
  // 未来设想关键词
  "未来版本",
  "计划中",
  "即将推出",
  "TODO",
  "FIXME",
  "待实现",
  "暂未支持",
] as const;
