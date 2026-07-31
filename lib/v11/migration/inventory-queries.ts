import { db } from "@/lib/db/client";
/**
 * S13-W01 迁移盘点查询：孤儿引用、重复数据和状态分布检测。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W01
 *         （固化当前表、行数、关键状态、孤儿引用、重复数据、时间范围和存储体量清单）。
 *
 * 所有查询只读旧表，不修改任何数据；表名使用反引号转义避免保留字冲突。
 */
import { sql } from "drizzle-orm";

// ─── 孤儿引用检测 ──────────────────────────────────────────

/** 单条孤儿引用检测结果。 */
export interface OrphanReferenceFinding {
  /** 子表（引用方）物理表名。 */
  readonly childTable: string;
  /** 父表（被引用方）物理表名。 */
  readonly parentTable: string;
  /** 外键列名。 */
  readonly foreignKeyColumn: string;
  /** 孤儿引用行数。 */
  readonly orphanCount: number;
}

/** 孤儿引用检测规则（子表 FK → 父表 PK）。 */
const ORPHAN_CHECKS: ReadonlyArray<{
  readonly childTable: string;
  readonly parentTable: string;
  readonly fkColumn: string;
}> = [
  // 会话域
  { childTable: "Message", parentTable: "Thread", fkColumn: "threadId" },
  { childTable: "ThreadEvent", parentTable: "Thread", fkColumn: "threadId" },
  { childTable: "ThreadRun", parentTable: "Thread", fkColumn: "threadId" },
  // 运行事实域
  { childTable: "ToolRun", parentTable: "Thread", fkColumn: "threadId" },
  { childTable: "ToolRun", parentTable: "ThreadRun", fkColumn: "runId" },
  { childTable: "RunTranscriptChunk", parentTable: "ThreadRun", fkColumn: "runId" },
  { childTable: "ThreadRunSkill", parentTable: "ThreadRun", fkColumn: "runId" },
  { childTable: "ContextSnapshot", parentTable: "ThreadRun", fkColumn: "runId" },
  // 上下文与计划域
  { childTable: "ContextSummary", parentTable: "Thread", fkColumn: "threadId" },
  { childTable: "ThreadPlan", parentTable: "Thread", fkColumn: "threadId" },
  { childTable: "ThreadPlanItem", parentTable: "ThreadPlan", fkColumn: "planId" },
  // 后台任务与子代理域
  { childTable: "BackgroundTask", parentTable: "Thread", fkColumn: "threadId" },
  { childTable: "SubagentRun", parentTable: "Thread", fkColumn: "parentThreadId" },
  // 记忆域
  { childTable: "MemoryEmbedding", parentTable: "MemoryEntry", fkColumn: "memoryId" },
  // Skill 域
  { childTable: "SkillVersion", parentTable: "Skill", fkColumn: "skillId" },
  { childTable: "SkillSyncMapping", parentTable: "Skill", fkColumn: "localSkillId" },
  // 策略与审批域
  { childTable: "ToolApprovalRequest", parentTable: "Thread", fkColumn: "threadId" },
  { childTable: "ToolApprovalRequest", parentTable: "ToolRun", fkColumn: "toolRunId" },
  // 部署与密钥域
  { childTable: "Deployment", parentTable: "Thread", fkColumn: "threadId" },
  // Git 检查点域
  { childTable: "GitCheckpoint", parentTable: "Thread", fkColumn: "threadId" },
  // 身份域
  { childTable: "UserRole", parentTable: "User", fkColumn: "userId" },
  { childTable: "UserRole", parentTable: "Role", fkColumn: "roleId" },
  { childTable: "RolePermission", parentTable: "Role", fkColumn: "roleId" },
  // 设备域
  { childTable: "DesktopDevice", parentTable: "User", fkColumn: "userId" },
];

/** 检测所有孤儿引用。 */
export async function detectOrphanReferences(): Promise<OrphanReferenceFinding[]> {
  const findings: OrphanReferenceFinding[] = [];

  for (const check of ORPHAN_CHECKS) {
    try {
      const [rows] = (await db.execute(sql`
        SELECT COUNT(*) as orphan_count
        FROM ${sql.raw(`\`${check.childTable}\``)} AS c
        LEFT JOIN ${sql.raw(`\`${check.parentTable}\``)} AS p
          ON c.${sql.raw(`\`${check.fkColumn}\``)} = p.id
        WHERE c.${sql.raw(`\`${check.fkColumn}\``)} IS NOT NULL
          AND p.id IS NULL
      `)) as unknown as [{ orphan_count: number }[]];
      const orphanCount = rows[0]?.orphan_count ?? 0;
      if (orphanCount > 0) {
        findings.push({
          childTable: check.childTable,
          parentTable: check.parentTable,
          foreignKeyColumn: check.fkColumn,
          orphanCount,
        });
      }
    } catch {
      // 表不存在时跳过
    }
  }

  return findings;
}

// ─── 重复数据检测 ──────────────────────────────────────────

/** 单条重复数据检测结果。 */
export interface DuplicateFinding {
  /** 物理表名。 */
  readonly table: string;
  /** 重复检测列名。 */
  readonly column: string;
  /** 重复值。 */
  readonly duplicateValue: string;
  /** 出现次数。 */
  readonly count: number;
}

/** 重复数据检测规则。 */
const DUPLICATE_CHECKS: ReadonlyArray<{
  readonly table: string;
  readonly column: string;
}> = [
  { table: "User", column: "externalId" },
  { table: "Skill", column: "name" },
  { table: "Agent", column: "name" },
  { table: "ProviderProfile", column: "name" },
  { table: "McpServerConfig", column: "name" },
  { table: "CustomTool", column: "name" },
  { table: "DesktopDevice", column: "deviceId" },
  { table: "ThreadRunSkill", column: "contentHash" },
];

/** 检测所有重复数据。 */
export async function detectDuplicates(): Promise<DuplicateFinding[]> {
  const findings: DuplicateFinding[] = [];

  for (const check of DUPLICATE_CHECKS) {
    try {
      const [rows] = (await db.execute(sql`
        SELECT ${sql.raw(`\`${check.column}\``)} AS value, COUNT(*) AS cnt
        FROM ${sql.raw(`\`${check.table}\``)}
        WHERE ${sql.raw(`\`${check.column}\``)} IS NOT NULL
          AND ${sql.raw(`\`${check.column}\``)} != ''
        GROUP BY ${sql.raw(`\`${check.column}\``)}
        HAVING COUNT(*) > 1
        ORDER BY cnt DESC
      `)) as unknown as [{ value: string; cnt: number }[]];
      for (const row of rows) {
        findings.push({
          table: check.table,
          column: check.column,
          duplicateValue: row.value,
          count: row.cnt,
        });
      }
    } catch {
      // 表不存在时跳过
    }
  }

  return findings;
}

// ─── 状态分布检测 ──────────────────────────────────────────

/** 单表状态分布结果。 */
export interface StatusDistribution {
  /** 物理表名。 */
  readonly table: string;
  /** 状态列名。 */
  readonly statusColumn: string;
  /** 状态值 → 行数。 */
  readonly distribution: ReadonlyArray<{ readonly value: string; readonly count: number }>;
}

/** 状态分布检测规则。 */
const STATUS_CHECKS: ReadonlyArray<{
  readonly table: string;
  readonly column: string;
}> = [
  { table: "Thread", column: "status" },
  { table: "ThreadRun", column: "status" },
  { table: "ToolRun", column: "status" },
  { table: "Skill", column: "status" },
  { table: "SkillVersion", column: "status" },
  { table: "BackgroundTask", column: "status" },
  { table: "SubagentRun", column: "status" },
  { table: "MemoryEntry", column: "status" },
  { table: "MemoryEmbedding", column: "status" },
  { table: "McpServerConfig", column: "enabled" },
  { table: "CustomTool", column: "enabled" },
  { table: "Deployment", column: "status" },
  { table: "SecretMount", column: "status" },
  { table: "DesktopDevice", column: "status" },
  { table: "ToolApprovalRequest", column: "status" },
  { table: "ThreadPlan", column: "status" },
];

/** 检测所有表的状态分布。 */
export async function detectStatusDistributions(): Promise<StatusDistribution[]> {
  const results: StatusDistribution[] = [];

  for (const check of STATUS_CHECKS) {
    try {
      const [rows] = (await db.execute(sql`
        SELECT ${sql.raw(`\`${check.column}\``)} AS value, COUNT(*) AS count
        FROM ${sql.raw(`\`${check.table}\``)}
        GROUP BY ${sql.raw(`\`${check.column}\``)}
        ORDER BY count DESC
      `)) as unknown as [{ value: string; count: number }[]];
      if (rows.length > 0) {
        results.push({
          table: check.table,
          statusColumn: check.column,
          distribution: rows.map((r) => ({
            value: r.value ?? "NULL",
            count: r.count,
          })),
        });
      }
    } catch {
      // 表不存在时跳过
    }
  }

  return results;
}

// ─── 存储体量估算 ──────────────────────────────────────────

/** 单表存储体量估算。 */
export interface TableStorageEstimate {
  /** 物理表名。 */
  readonly table: string;
  /** 行数。 */
  readonly rowCount: number;
  /** 估算数据大小（字节）。 */
  readonly dataLength: number;
  /** 估算索引大小（字节）。 */
  readonly indexLength: number;
  /** 总大小（字节）。 */
  readonly totalBytes: number;
}

/** 查询所有旧表的存储体量。 */
export async function estimateTableStorage(): Promise<TableStorageEstimate[]> {
  const tableNames = [
    "User",
    "Role",
    "RolePermission",
    "UserRole",
    "Thread",
    "Message",
    "ThreadEvent",
    "ThreadRun",
    "ToolRun",
    "RunTranscriptChunk",
    "ThreadRunSkill",
    "ContextSnapshot",
    "Skill",
    "SkillVersion",
    "SkillSyncMapping",
    "PolicyConfig",
    "PolicyConfigHistory",
    "ToolPermissionRule",
    "ToolApprovalRequest",
    "Agent",
    "ProviderProfile",
    "AdminAuditLog",
    "ContextSummary",
    "ThreadPlan",
    "ThreadPlanItem",
    "BackgroundTask",
    "SubagentDefinition",
    "SubagentRun",
    "MemoryEntry",
    "MemoryEmbedding",
    "McpServerConfig",
    "CustomTool",
    "Deployment",
    "SecretMount",
    "GitCheckpoint",
    "ChatExample",
    "AuditFailureLog",
    "DesktopDevice",
  ];

  const results: TableStorageEstimate[] = [];

  for (const table of tableNames) {
    try {
      const [rows] = (await db.execute(sql`
        SELECT table_rows AS row_count, data_length, index_length
        FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ${table}
      `)) as unknown as [
        {
          row_count: number;
          data_length: number;
          index_length: number;
        }[],
      ];
      const row = rows[0];
      if (row) {
        results.push({
          table,
          rowCount: row.row_count ?? 0,
          dataLength: row.data_length ?? 0,
          indexLength: row.index_length ?? 0,
          totalBytes: (row.data_length ?? 0) + (row.index_length ?? 0),
        });
      }
    } catch {
      // 查询失败时跳过
    }
  }

  return results;
}

// ─── 综合盘点报告 ──────────────────────────────────────────

/** 综合盘点报告。 */
export interface ComprehensiveInventoryReport {
  /** 生成时间（ISO 字符串）。 */
  readonly generatedAt: string;
  /** 孤儿引用发现。 */
  readonly orphanReferences: readonly OrphanReferenceFinding[];
  /** 重复数据发现。 */
  readonly duplicates: readonly DuplicateFinding[];
  /** 状态分布。 */
  readonly statusDistributions: readonly StatusDistribution[];
  /** 存储体量。 */
  readonly storageEstimates: readonly TableStorageEstimate[];
  /** 存储体量总计（字节）。 */
  readonly totalStorageBytes: number;
  /** 是否有阻断性问题（存在孤儿或重复时为 true）。 */
  readonly hasBlockingIssues: boolean;
}

/** 生成综合盘点报告（孤儿 + 重复 + 状态分布 + 存储体量）。 */
export async function generateComprehensiveReport(): Promise<ComprehensiveInventoryReport> {
  const [orphans, duplicates, statusDistributions, storageEstimates] = await Promise.all([
    detectOrphanReferences(),
    detectDuplicates(),
    detectStatusDistributions(),
    estimateTableStorage(),
  ]);

  const totalStorageBytes = storageEstimates.reduce((sum, s) => sum + s.totalBytes, 0);
  const hasBlockingIssues = orphans.length > 0 || duplicates.length > 0;

  return {
    generatedAt: new Date().toISOString(),
    orphanReferences: orphans,
    duplicates,
    statusDistributions,
    storageEstimates,
    totalStorageBytes,
    hasBlockingIssues,
  };
}
