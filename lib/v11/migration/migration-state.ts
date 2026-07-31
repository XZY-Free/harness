/**
 * S13-W02 迁移状态存储：幂等性追踪与批次记录。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W02
 *         （迁移按 tenant/时间/对象分片，可重复运行且不会生成重复 Item、Event、Effect 或 Artifact；
 *           执行模式记录批次、游标、源/目标计数、失败对象和重跑结果）。
 *
 * 设计：
 * - 内存存储（测试用），接口可替换为 DB 后端（生产用）。
 * - 幂等键 = (sourceTable, sourceId, contentHash)；同键已迁移则跳过。
 * - 批次记录含游标，支持断点续跑。
 */
import { createHash } from "node:crypto";
import type { MigrationDomain } from "@/lib/v11/migration/mapping-baseline";

// ─── 内容哈希 ──────────────────────────────────────────────

/**
 * 计算源记录的内容哈希（用于幂等性检测）。
 * 排除 id 和时间戳字段（这些不变但不应影响内容比对）。
 */
export function computeContentHash(
  record: Record<string, unknown>,
  excludeFields: readonly string[] = ["id", "createdAt", "updatedAt"],
): string {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (!excludeFields.includes(key)) {
      filtered[key] = record[key];
    }
  }
  const json = JSON.stringify(filtered);
  return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

// ─── 迁移状态记录 ──────────────────────────────────────────

/** 单条迁移状态。 */
export interface MigrationStateRecord {
  /** 源表物理名。 */
  readonly sourceTable: string;
  /** 源记录 ID。 */
  readonly sourceId: string;
  /** 源记录内容哈希。 */
  readonly contentHash: string;
  /** V11 目标表名。 */
  readonly targetTable: string;
  /** V11 目标记录 ID。 */
  readonly targetId: string;
  /** 所属批次 ID。 */
  readonly batchId: string;
  /** 迁移时间（ISO 字符串）。 */
  readonly migratedAt: string;
  /** 状态。 */
  readonly status: MigrationRecordStatus;
}

export type MigrationRecordStatus = "migrated" | "skipped" | "anomaly";

/** 异常队列记录。 */
export interface AnomalyQueueEntry {
  /** 源表物理名。 */
  readonly sourceTable: string;
  /** 源记录 ID。 */
  readonly sourceId: string;
  /** 异常原因。 */
  readonly reason: string;
  /** 所属批次 ID。 */
  readonly batchId: string;
  /** 记录时间（ISO 字符串）。 */
  readonly recordedAt: string;
}

// ─── 迁移批次 ──────────────────────────────────────────────

export type MigrationBatchStatus = "pending" | "running" | "completed" | "failed" | "partial";

/** 单个迁移批次。 */
export interface MigrationBatch {
  /** 批次 ID（唯一）。 */
  readonly id: string;
  /** 迁移域。 */
  readonly domain: MigrationDomain;
  /** 源表物理名。 */
  readonly sourceTable: string;
  /** 批次状态。 */
  status: MigrationBatchStatus;
  /** 游标（最后处理的源记录 ID，null 表示从头开始或已完成）。 */
  cursor: string | null;
  /** 源记录数。 */
  sourceCount: number;
  /** 成功迁移到目标的记录数。 */
  targetCount: number;
  /** 失败记录数。 */
  failureCount: number;
  /** 异常队列记录数。 */
  anomalyCount: number;
  /** 跳过记录数（已迁移或幂等跳过）。 */
  skipCount: number;
  /** 开始时间（ISO 字符串）。 */
  readonly startedAt: string;
  /** 完成时间（ISO 字符串，null 表示未完成）。 */
  completedAt: string | null;
  /** 错误信息（失败时填充）。 */
  errorMessage: string | null;
}

// ─── 状态存储接口 ──────────────────────────────────────────

/** 迁移状态存储接口（内存实现可用于测试，生产可替换为 DB 后端）。 */
export interface MigrationStateStore {
  /** 记录一条迁移状态。 */
  recordMigration(record: MigrationStateRecord): void;

  /** 检查某条源记录是否已迁移（按 sourceTable + sourceId）。 */
  getMigration(sourceTable: string, sourceId: string): MigrationStateRecord | undefined;

  /** 检查内容哈希是否变化（返回之前的哈希，用于检测源数据变更）。 */
  getContentHash(sourceTable: string, sourceId: string): string | undefined;

  /** 获取某表的所有已迁移记录数。 */
  getMigratedCount(sourceTable: string): number;

  /** 记录异常队列条目。 */
  recordAnomaly(entry: AnomalyQueueEntry): void;

  /** 获取某表的异常队列。 */
  getAnomalies(sourceTable: string): readonly AnomalyQueueEntry[];

  /** 获取所有异常队列条目。 */
  getAllAnomalies(): readonly AnomalyQueueEntry[];

  /** 创建批次。 */
  createBatch(batch: MigrationBatch): void;

  /** 更新批次。 */
  updateBatch(
    id: string,
    updates: Partial<Omit<MigrationBatch, "id" | "domain" | "sourceTable" | "startedAt">>,
  ): void;

  /** 获取批次。 */
  getBatch(id: string): MigrationBatch | undefined;

  /** 获取所有批次。 */
  listBatches(): readonly MigrationBatch[];

  /** 获取某表的最近批次。 */
  getLatestBatch(sourceTable: string): MigrationBatch | undefined;

  /** 清空所有状态（测试用）。 */
  clear(): void;
}

// ─── 内存状态存储实现 ──────────────────────────────────────

/** 内存迁移状态存储（测试和开发用）。 */
export class InMemoryMigrationStateStore implements MigrationStateStore {
  private readonly migrations = new Map<string, MigrationStateRecord>();
  private readonly anomalies: AnomalyQueueEntry[] = [];
  private readonly batches = new Map<string, MigrationBatch>();
  private readonly migratedCounts = new Map<string, number>();

  private migrationKey(sourceTable: string, sourceId: string): string {
    return `${sourceTable}::${sourceId}`;
  }

  recordMigration(record: MigrationStateRecord): void {
    const key = this.migrationKey(record.sourceTable, record.sourceId);
    this.migrations.set(key, record);
    if (record.status === "migrated") {
      const count = this.migratedCounts.get(record.sourceTable) ?? 0;
      this.migratedCounts.set(record.sourceTable, count + 1);
    }
  }

  getMigration(sourceTable: string, sourceId: string): MigrationStateRecord | undefined {
    return this.migrations.get(this.migrationKey(sourceTable, sourceId));
  }

  getContentHash(sourceTable: string, sourceId: string): string | undefined {
    return this.migrations.get(this.migrationKey(sourceTable, sourceId))?.contentHash;
  }

  getMigratedCount(sourceTable: string): number {
    return this.migratedCounts.get(sourceTable) ?? 0;
  }

  recordAnomaly(entry: AnomalyQueueEntry): void {
    this.anomalies.push(entry);
  }

  getAnomalies(sourceTable: string): readonly AnomalyQueueEntry[] {
    return this.anomalies.filter((a) => a.sourceTable === sourceTable);
  }

  getAllAnomalies(): readonly AnomalyQueueEntry[] {
    return [...this.anomalies];
  }

  createBatch(batch: MigrationBatch): void {
    this.batches.set(batch.id, batch);
  }

  updateBatch(
    id: string,
    updates: Partial<Omit<MigrationBatch, "id" | "domain" | "sourceTable" | "startedAt">>,
  ): void {
    const batch = this.batches.get(id);
    if (!batch) {
      throw new Error(`Batch not found: ${id}`);
    }
    Object.assign(batch, updates);
  }

  getBatch(id: string): MigrationBatch | undefined {
    return this.batches.get(id);
  }

  listBatches(): readonly MigrationBatch[] {
    return [...this.batches.values()];
  }

  getLatestBatch(sourceTable: string): MigrationBatch | undefined {
    const tableBatches = this.listBatches().filter((b) => b.sourceTable === sourceTable);
    if (tableBatches.length === 0) return undefined;
    return tableBatches[tableBatches.length - 1];
  }

  clear(): void {
    this.migrations.clear();
    this.anomalies.length = 0;
    this.batches.clear();
    this.migratedCounts.clear();
  }
}

// ─── 批次 ID 生成 ──────────────────────────────────────────

let batchCounter = 0;

/** 生成唯一批次 ID。 */
export function generateBatchId(domain: MigrationDomain, sourceTable: string): string {
  batchCounter += 1;
  const timestamp = Date.now();
  return `batch-${domain}-${sourceTable}-${timestamp}-${batchCounter}`;
}
