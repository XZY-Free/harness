/**
 * S13-W02 dry-run 模式：只读旧数据，生成数量、关系、状态、hash、异常和预计耗时报告。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W02
 *         （dry-run 只读旧数据并生成数量、关系、状态、hash、异常和预计耗时报告）。
 *
 * dry-run 不写入任何 V11 表，仅分析旧数据并产出结构化报告。
 */
import { db } from "@/lib/db/client";
import {
  MAPPING_BASELINE,
  MAPPING_VERSION,
  MIGRATION_DOMAINS,
  type MigrationDomain,
  buildSourceId,
  getCursorColumn,
  getMappingsByDomain,
  isPaginated,
} from "@/lib/v11/migration/mapping-baseline";
import { computeContentHash } from "@/lib/v11/migration/migration-state";
import { sql } from "drizzle-orm";

// ─── dry-run 报告类型 ──────────────────────────────────────

/** 单表 dry-run 分析结果。 */
export interface DryRunTableReport {
  /** 旧表逻辑名。 */
  readonly legacyTable: string;
  /** MySQL 物理表名。 */
  readonly physicalTable: string;
  /** 迁移域。 */
  readonly domain: MigrationDomain;
  /** 源记录总数。 */
  readonly recordCount: number;
  /** 预计可迁移记录数（排除异常）。 */
  readonly migratableCount: number;
  /** 预计异常记录数。 */
  readonly anomalyCount: number;
  /** 内容哈希集合（用于检测重复内容）。 */
  readonly uniqueContentHashes: number;
  /** 重复内容记录数（相同哈希出现多次）。 */
  readonly duplicateContentCount: number;
  /** 预计迁移耗时（毫秒）。 */
  readonly estimatedDurationMs: number;
  /** 异常样本（最多 10 条）。 */
  readonly anomalySamples: readonly AnomalySample[];
  /** 是否核心实体。 */
  readonly coreEntity: boolean;
  /** V11 目标表列表。 */
  readonly v11Targets: readonly string[];
}

/** 异常样本。 */
export interface AnomalySample {
  /** 源记录 ID。 */
  readonly sourceId: string;
  /** 异常原因。 */
  readonly reason: string;
}

/** 按域汇总的 dry-run 结果。 */
export interface DryRunDomainReport {
  /** 迁移域。 */
  readonly domain: MigrationDomain;
  /** 表数。 */
  readonly tableCount: number;
  /** 总记录数。 */
  readonly totalRecords: number;
  /** 总可迁移记录数。 */
  readonly totalMigratable: number;
  /** 总异常记录数。 */
  readonly totalAnomalies: number;
  /** 总预计耗时（毫秒）。 */
  readonly totalEstimatedDurationMs: number;
  /** 表明细。 */
  readonly tables: readonly DryRunTableReport[];
}

/** 完整 dry-run 报告。 */
export interface DryRunReport {
  /** 映射版本。 */
  readonly mappingVersion: typeof MAPPING_VERSION;
  /** 生成时间（ISO 字符串）。 */
  readonly generatedAt: string;
  /** 旧表总数。 */
  readonly totalTables: number;
  /** 总记录数。 */
  readonly totalRecords: number;
  /** 总可迁移记录数。 */
  readonly totalMigratable: number;
  /** 总异常记录数。 */
  readonly totalAnomalies: number;
  /** 总重复内容记录数。 */
  readonly totalDuplicateContent: number;
  /** 总预计耗时（毫秒）。 */
  readonly totalEstimatedDurationMs: number;
  /** 阻断性问题列表。 */
  readonly blockingIssues: readonly string[];
  /** 按域汇总。 */
  readonly byDomain: readonly DryRunDomainReport[];
  /** 全部表明细。 */
  readonly tables: readonly DryRunTableReport[];
}

// ─── dry-run 配置 ──────────────────────────────────────────

/** dry-run 配置。 */
export interface DryRunOptions {
  /** 每批处理记录数（用于耗时估算）。 */
  readonly batchSize: number;
  /** 每秒处理记录数（用于耗时估算）。 */
  readonly recordsPerSecond: number;
  /** 每表最多采样异常数。 */
  readonly maxAnomalySamples: number;
}

/** 默认 dry-run 配置。 */
export const DEFAULT_DRY_RUN_OPTIONS: DryRunOptions = {
  batchSize: 500,
  recordsPerSecond: 200,
  maxAnomalySamples: 10,
};

// ─── 异常检测规则 ──────────────────────────────────────────

/** 异常检测函数类型。 */
type AnomalyChecker = (record: Record<string, unknown>) => string | null;

/** 按表名注册的异常检测规则。 */
const ANOMALY_CHECKERS: Record<string, AnomalyChecker> = {
  User: (r) => {
    if (!r.externalId) return "externalId 为空";
    return null;
  },
  Thread: (r) => {
    if (r.status === "deleted" && !r.deletedAt) return "status=deleted 且无 deletedAt";
    return null;
  },
  Message: (r) => {
    if (!r.threadId) return "threadId 为空（孤儿消息）";
    return null;
  },
  ThreadEvent: (r) => {
    if (!r.threadId) return "threadId 为空";
    return null;
  },
  ThreadRun: (r) => {
    if (!r.threadId) return "threadId 不存在";
    return null;
  },
  ToolRun: (r) => {
    if (!r.threadId) return "threadId 或 runId 不存在";
    return null;
  },
  Skill: (r) => {
    if (!r.name) return "name 重复";
    return null;
  },
  SkillVersion: (r) => {
    if (!r.commitSha) return "commitSha 为空";
    return null;
  },
  Agent: (r) => {
    if (!r.name) return "name 重复";
    return null;
  },
  UserRole: (r) => {
    if (!r.userId) return "userId 不存在";
    return null;
  },
  RolePermission: (r) => {
    if (!r.permission) return "permission 不在 ACTION_CODES 目录";
    return null;
  },
  MemoryEntry: (r) => {
    if (!r.scopeRef) return "scopeRef 不存在";
    return null;
  },
  MemoryEmbedding: (r) => {
    if (!r.memoryId) return "memoryId 不存在";
    return null;
  },
  Deployment: (r) => {
    if (!r.threadId) return "threadId 不存在";
    return null;
  },
  SecretMount: (r) => {
    if (!r.scopeRef) return "scopeRef 不存在";
    return null;
  },
  GitCheckpoint: (r) => {
    if (!r.threadId) return "threadId 不存在";
    return null;
  },
  DesktopDevice: (r) => {
    if (!r.userId) return "userId 不存在";
    return null;
  },
  BackgroundTask: (r) => {
    if (!r.threadId) return "threadId 不存在";
    return null;
  },
  SubagentRun: (r) => {
    if (!r.parentThreadId) return "parentThreadId 不存在";
    return null;
  },
};

// ─── dry-run 核心实现 ──────────────────────────────────────

/** 分析单张旧表。 */
async function analyzeTable(
  mapping: (typeof MAPPING_BASELINE)[number],
  options: DryRunOptions,
): Promise<DryRunTableReport> {
  const tableName = mapping.physicalTable;
  const checker = ANOMALY_CHECKERS[mapping.legacyTable];

  // 查询总记录数
  const [countRows] = (await db.execute(
    sql`SELECT COUNT(*) as total FROM ${sql.raw(`\`${tableName}\``)}`,
  )) as unknown as [{ total: number }[]];
  const recordCount = countRows[0]?.total ?? 0;

  let migratableCount = recordCount;
  let anomalyCount = 0;
  let duplicateContentCount = 0;
  const anomalySamples: AnomalySample[] = [];
  const contentHashes = new Map<string, number>();

  if (recordCount > 0) {
    // 分批读取记录进行分析；无单一可排序列时一次性读取不分页
    const cursorCol = getCursorColumn(mapping);
    const paginated = isPaginated(mapping);
    let cursor: string | null = null;
    const hasChecker = checker !== undefined;

    while (true) {
      const query = paginated
        ? cursor
          ? sql`SELECT * FROM ${sql.raw(`\`${tableName}\``)} WHERE ${sql.raw(`\`${cursorCol}\``)} > ${cursor} ORDER BY ${sql.raw(`\`${cursorCol}\``)} LIMIT ${options.batchSize}`
          : sql`SELECT * FROM ${sql.raw(`\`${tableName}\``)} ORDER BY ${sql.raw(`\`${cursorCol}\``)} LIMIT ${options.batchSize}`
        : sql`SELECT * FROM ${sql.raw(`\`${tableName}\``)}`;

      const [rows] = (await db.execute(query)) as unknown as [Record<string, unknown>[]];

      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        const sourceId = buildSourceId(mapping, row);
        if (paginated) cursor = sourceId;

        // 计算内容哈希
        const hash = computeContentHash(row);
        const hashCount = contentHashes.get(hash) ?? 0;
        contentHashes.set(hash, hashCount + 1);
        if (hashCount > 0) {
          duplicateContentCount += 1;
        }

        // 异常检测
        if (hasChecker) {
          const anomalyReason = checker(row);
          if (anomalyReason) {
            anomalyCount += 1;
            migratableCount -= 1;
            if (anomalySamples.length < options.maxAnomalySamples) {
              anomalySamples.push({ sourceId, reason: anomalyReason });
            }
          }
        }
      }

      // 不分页模式：一次性读取后结束；分页模式：不足一批时结束
      if (!paginated || rows.length < options.batchSize) break;
    }
  }

  const uniqueContentHashes = contentHashes.size;
  const estimatedDurationMs = Math.ceil((recordCount / options.recordsPerSecond) * 1000);

  return {
    legacyTable: mapping.legacyTable,
    physicalTable: mapping.physicalTable,
    domain: mapping.domain,
    recordCount,
    migratableCount,
    anomalyCount,
    uniqueContentHashes,
    duplicateContentCount,
    estimatedDurationMs,
    anomalySamples,
    coreEntity: mapping.coreEntity,
    v11Targets: mapping.v11Targets,
  };
}

/** 生成完整 dry-run 报告。 */
export async function generateDryRunReport(
  options: DryRunOptions = DEFAULT_DRY_RUN_OPTIONS,
): Promise<DryRunReport> {
  const tableReports: DryRunTableReport[] = [];

  for (const mapping of MAPPING_BASELINE) {
    try {
      const report = await analyzeTable(mapping, options);
      tableReports.push(report);
    } catch {
      // 表不存在或查询失败时记录零值
      tableReports.push({
        legacyTable: mapping.legacyTable,
        physicalTable: mapping.physicalTable,
        domain: mapping.domain,
        recordCount: 0,
        migratableCount: 0,
        anomalyCount: 0,
        uniqueContentHashes: 0,
        duplicateContentCount: 0,
        estimatedDurationMs: 0,
        anomalySamples: [],
        coreEntity: mapping.coreEntity,
        v11Targets: mapping.v11Targets,
      });
    }
  }

  const totalRecords = tableReports.reduce((sum, t) => sum + t.recordCount, 0);
  const totalMigratable = tableReports.reduce((sum, t) => sum + t.migratableCount, 0);
  const totalAnomalies = tableReports.reduce((sum, t) => sum + t.anomalyCount, 0);
  const totalDuplicateContent = tableReports.reduce((sum, t) => sum + t.duplicateContentCount, 0);
  const totalEstimatedDurationMs = tableReports.reduce((sum, t) => sum + t.estimatedDurationMs, 0);

  // 按域汇总
  const byDomain: DryRunDomainReport[] = MIGRATION_DOMAINS.map((domain) => {
    const domainTables = tableReports.filter((t) => t.domain === domain);
    return {
      domain,
      tableCount: domainTables.length,
      totalRecords: domainTables.reduce((sum, t) => sum + t.recordCount, 0),
      totalMigratable: domainTables.reduce((sum, t) => sum + t.migratableCount, 0),
      totalAnomalies: domainTables.reduce((sum, t) => sum + t.anomalyCount, 0),
      totalEstimatedDurationMs: domainTables.reduce((sum, t) => sum + t.estimatedDurationMs, 0),
      tables: domainTables,
    };
  });

  // 阻断性问题
  const blockingIssues: string[] = [];
  if (totalAnomalies > 0) {
    blockingIssues.push(`存在 ${totalAnomalies} 条异常记录，需在迁移前处理或确认入异常队列`);
  }
  if (totalDuplicateContent > 0) {
    blockingIssues.push(`存在 ${totalDuplicateContent} 条重复内容记录，需确认去重策略`);
  }

  return {
    mappingVersion: MAPPING_VERSION,
    generatedAt: new Date().toISOString(),
    totalTables: tableReports.length,
    totalRecords,
    totalMigratable,
    totalAnomalies,
    totalDuplicateContent,
    totalEstimatedDurationMs,
    blockingIssues,
    byDomain,
    tables: tableReports,
  };
}

/** 生成单域 dry-run 报告。 */
export async function generateDryRunReportForDomain(
  domain: MigrationDomain,
  options: DryRunOptions = DEFAULT_DRY_RUN_OPTIONS,
): Promise<DryRunDomainReport> {
  const mappings = getMappingsByDomain(domain);
  const tableReports: DryRunTableReport[] = [];

  for (const mapping of mappings) {
    try {
      const report = await analyzeTable(mapping, options);
      tableReports.push(report);
    } catch {
      tableReports.push({
        legacyTable: mapping.legacyTable,
        physicalTable: mapping.physicalTable,
        domain: mapping.domain,
        recordCount: 0,
        migratableCount: 0,
        anomalyCount: 0,
        uniqueContentHashes: 0,
        duplicateContentCount: 0,
        estimatedDurationMs: 0,
        anomalySamples: [],
        coreEntity: mapping.coreEntity,
        v11Targets: mapping.v11Targets,
      });
    }
  }

  return {
    domain,
    tableCount: tableReports.length,
    totalRecords: tableReports.reduce((sum, t) => sum + t.recordCount, 0),
    totalMigratable: tableReports.reduce((sum, t) => sum + t.migratableCount, 0),
    totalAnomalies: tableReports.reduce((sum, t) => sum + t.anomalyCount, 0),
    totalEstimatedDurationMs: tableReports.reduce((sum, t) => sum + t.estimatedDurationMs, 0),
    tables: tableReports,
  };
}

/** 将 dry-run 报告格式化为可读字符串。 */
export function formatDryRunReport(report: DryRunReport): string {
  const lines: string[] = [
    "V11 迁移 dry-run 报告",
    `映射版本: ${report.mappingVersion}`,
    `生成时间: ${report.generatedAt}`,
    "",
    "总计:",
    `  旧表数: ${report.totalTables}`,
    `  总记录数: ${report.totalRecords}`,
    `  可迁移: ${report.totalMigratable}`,
    `  异常: ${report.totalAnomalies}`,
    `  重复内容: ${report.totalDuplicateContent}`,
    `  预计耗时: ${(report.totalEstimatedDurationMs / 1000).toFixed(1)}s`,
    "",
  ];

  if (report.blockingIssues.length > 0) {
    lines.push("阻断性问题:");
    for (const issue of report.blockingIssues) {
      lines.push(`  ! ${issue}`);
    }
    lines.push("");
  }

  lines.push("按域汇总:");
  for (const domain of report.byDomain) {
    lines.push(
      `  ${domain.domain}: ${domain.totalRecords} 条 (${domain.totalMigratable} 可迁, ${domain.totalAnomalies} 异常, ${(domain.totalEstimatedDurationMs / 1000).toFixed(1)}s)`,
    );
  }

  return lines.join("\n");
}
