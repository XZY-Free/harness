/**
 * S13-W02 可重复迁移工具框架：按域分片、游标分页、幂等追踪、批次记录。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W02
 *         （迁移按 tenant/时间/对象分片，可重复运行且不会生成重复 Item、Event、Effect 或 Artifact；
 *           执行模式记录批次、游标、源/目标计数、失败对象和重跑结果；
 *           所有修复使用可执行迁移或 SQL，并在生产同构副本验证）。
 *
 * 架构：
 * - 按映射基线域顺序执行（identity → agent_skill → conversation → … → misc）。
 * - 每张表按 id 游标分页，支持断点续跑。
 * - 幂等：迁移前检查 (sourceTable, sourceId) 是否已迁移且内容哈希未变。
 * - 异常队列：满足映射基线 anomalyConditions 的记录入队，不迁移。
 * - dry-run 模式：只读分析，不写入 V11 目标。
 * - Transformer 接口：每张表注册一个转换器，将旧记录转为 V11 目标记录。
 */
import { db } from "@/lib/db/client";
import {
  type LegacyTableMapping,
  MAPPING_BASELINE,
  MIGRATION_DOMAINS,
  type MigrationDomain,
  buildSourceId,
  getCursorColumn,
  getMappingsByDomain,
  isPaginated,
} from "@/lib/v11/migration/mapping-baseline";
import {
  type AnomalyQueueEntry,
  type MigrationBatch,
  type MigrationStateRecord,
  type MigrationStateStore,
  computeContentHash,
  generateBatchId,
} from "@/lib/v11/migration/migration-state";
import { getV11Table } from "@/lib/v11/migration/v11-table-registry";
import { sql } from "drizzle-orm";

// ─── Transformer 接口 ──────────────────────────────────────

/** 单条源记录的转换结果。 */
export interface TransformResult {
  /** V11 目标记录列表（每条含表名和数据）。 */
  readonly targets: readonly TransformTarget[];
  /** 异常原因（非空时入异常队列，不迁移）。 */
  readonly anomalyReason?: string;
  /** 是否跳过（已迁移或无需迁移）。 */
  readonly skip?: boolean;
}

/** V11 目标记录。 */
export interface TransformTarget {
  /** V11 目标表名。 */
  readonly table: string;
  /** V11 目标记录数据。 */
  readonly data: Record<string, unknown>;
}

/** 迁移转换器：将旧记录转为 V11 目标记录。 */
export type MigrationTransformer = (
  sourceRecord: Record<string, unknown>,
) => TransformResult | Promise<TransformResult>;

// ─── 迁移运行器配置 ────────────────────────────────────────

/** 迁移运行器配置。 */
export interface MigrationRunnerOptions {
  /** 状态存储。 */
  readonly stateStore: MigrationStateStore;
  /** 每表注册的转换器（key = 物理表名）。 */
  readonly transformers: ReadonlyMap<string, MigrationTransformer>;
  /** 每批处理记录数。 */
  readonly batchSize: number;
  /** 是否 dry-run（只读，不写入 V11 目标）。 */
  readonly dryRun: boolean;
  /** 是否从上次断点续跑。 */
  readonly resume: boolean;
  /**
   * V11 目标表注册表（表名 → drizzle 表对象）。
   * 执行模式写入时通过此注册表查找表对象；未提供时仅 dry-run 可用。
   */
  readonly tableRegistry?: ReadonlyMap<string, unknown>;
}

// ─── 迁移运行结果 ──────────────────────────────────────────

/** 单表迁移结果。 */
export interface TableMigrationResult {
  /** 源表物理名。 */
  readonly sourceTable: string;
  /** 迁移域。 */
  readonly domain: MigrationDomain;
  /** 批次 ID。 */
  readonly batchId: string;
  /** 批次状态。 */
  readonly status: MigrationBatch["status"];
  /** 源记录数。 */
  readonly sourceCount: number;
  /** 成功迁移记录数。 */
  readonly targetCount: number;
  /** 失败记录数。 */
  readonly failureCount: number;
  /** 异常记录数。 */
  readonly anomalyCount: number;
  /** 跳过记录数。 */
  readonly skipCount: number;
  /** 游标（最后处理的 ID）。 */
  readonly cursor: string | null;
  /** 耗时（毫秒）。 */
  readonly durationMs: number;
  /** 错误信息。 */
  readonly errorMessage: string | null;
}

/** 域迁移结果。 */
export interface DomainMigrationResult {
  /** 迁移域。 */
  readonly domain: MigrationDomain;
  /** 表迁移结果列表。 */
  readonly tables: readonly TableMigrationResult[];
  /** 总源记录数。 */
  readonly totalSourceCount: number;
  /** 总目标记录数。 */
  readonly totalTargetCount: number;
  /** 总失败数。 */
  readonly totalFailureCount: number;
  /** 总异常数。 */
  readonly totalAnomalyCount: number;
  /** 总跳过数。 */
  readonly totalSkipCount: number;
  /** 总耗时（毫秒）。 */
  readonly totalDurationMs: number;
}

/** 完整迁移结果。 */
export interface MigrationRunResult {
  /** 映射版本。 */
  readonly mappingVersion: string;
  /** 是否 dry-run。 */
  readonly dryRun: boolean;
  /** 开始时间（ISO 字符串）。 */
  readonly startedAt: string;
  /** 完成时间（ISO 字符串）。 */
  readonly completedAt: string;
  /** 总耗时（毫秒）。 */
  readonly totalDurationMs: number;
  /** 域迁移结果列表。 */
  readonly domains: readonly DomainMigrationResult[];
  /** 总源记录数。 */
  readonly totalSourceCount: number;
  /** 总目标记录数。 */
  readonly totalTargetCount: number;
  /** 总失败数。 */
  readonly totalFailureCount: number;
  /** 总异常数。 */
  readonly totalAnomalyCount: number;
  /** 总跳过数。 */
  readonly totalSkipCount: number;
}

// ─── 迁移运行器 ────────────────────────────────────────────

/** 迁移运行器：按域顺序执行迁移，支持幂等、断点续跑和 dry-run。 */
export class MigrationRunner {
  constructor(private readonly options: MigrationRunnerOptions) {}

  /** 运行所有域的迁移。 */
  async runAll(): Promise<MigrationRunResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const domainResults: DomainMigrationResult[] = [];

    for (const domain of MIGRATION_DOMAINS) {
      const result = await this.runDomain(domain);
      domainResults.push(result);
    }

    const completedAt = new Date().toISOString();
    const totalDurationMs = Date.now() - startTime;

    return {
      mappingVersion: "migration-mapping-v1",
      dryRun: this.options.dryRun,
      startedAt,
      completedAt,
      totalDurationMs,
      domains: domainResults,
      totalSourceCount: domainResults.reduce((s, d) => s + d.totalSourceCount, 0),
      totalTargetCount: domainResults.reduce((s, d) => s + d.totalTargetCount, 0),
      totalFailureCount: domainResults.reduce((s, d) => s + d.totalFailureCount, 0),
      totalAnomalyCount: domainResults.reduce((s, d) => s + d.totalAnomalyCount, 0),
      totalSkipCount: domainResults.reduce((s, d) => s + d.totalSkipCount, 0),
    };
  }

  /** 运行单个域的迁移。 */
  async runDomain(domain: MigrationDomain): Promise<DomainMigrationResult> {
    const mappings = getMappingsByDomain(domain);
    const tableResults: TableMigrationResult[] = [];

    for (const mapping of mappings) {
      const result = await this.runTable(mapping);
      tableResults.push(result);
    }

    return {
      domain,
      tables: tableResults,
      totalSourceCount: tableResults.reduce((s, t) => s + t.sourceCount, 0),
      totalTargetCount: tableResults.reduce((s, t) => s + t.targetCount, 0),
      totalFailureCount: tableResults.reduce((s, t) => s + t.failureCount, 0),
      totalAnomalyCount: tableResults.reduce((s, t) => s + t.anomalyCount, 0),
      totalSkipCount: tableResults.reduce((s, t) => s + t.skipCount, 0),
      totalDurationMs: tableResults.reduce((s, t) => s + t.durationMs, 0),
    };
  }

  /** 运行单张表的迁移。 */
  async runTable(mapping: LegacyTableMapping): Promise<TableMigrationResult> {
    const { stateStore, transformers, batchSize, dryRun, resume } = this.options;
    const transformer = transformers.get(mapping.physicalTable);
    const batchId = generateBatchId(mapping.domain, mapping.physicalTable);
    const startTime = Date.now();

    // 创建批次
    const batch: MigrationBatch = {
      id: batchId,
      domain: mapping.domain,
      sourceTable: mapping.physicalTable,
      status: "running",
      cursor: resume ? (stateStore.getLatestBatch(mapping.physicalTable)?.cursor ?? null) : null,
      sourceCount: 0,
      targetCount: 0,
      failureCount: 0,
      anomalyCount: 0,
      skipCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
    };
    stateStore.createBatch(batch);

    let cursor = batch.cursor;
    let sourceCount = 0;
    let targetCount = 0;
    let failureCount = 0;
    let anomalyCount = 0;
    let skipCount = 0;
    let errorMessage: string | null = null;

    try {
      const cursorCol = getCursorColumn(mapping);
      const paginated = isPaginated(mapping);

      while (true) {
        // 游标分页读取源记录；无单一可排序列时一次性读取不分页
        const query = paginated
          ? cursor !== null
            ? sql`SELECT * FROM ${sql.raw(`\`${mapping.physicalTable}\``)} WHERE ${sql.raw(`\`${cursorCol}\``)} > ${cursor} ORDER BY ${sql.raw(`\`${cursorCol}\``)} LIMIT ${batchSize}`
            : sql`SELECT * FROM ${sql.raw(`\`${mapping.physicalTable}\``)} ORDER BY ${sql.raw(`\`${cursorCol}\``)} LIMIT ${batchSize}`
          : sql`SELECT * FROM ${sql.raw(`\`${mapping.physicalTable}\``)}`;

        const [rows] = (await db.execute(query)) as unknown as [Record<string, unknown>[]];

        if (!rows || rows.length === 0) break;

        for (const row of rows) {
          const sourceId = buildSourceId(mapping, row);
          if (paginated) cursor = sourceId;
          sourceCount += 1;

          // 幂等检查：已迁移且内容哈希未变则跳过
          const existingState = stateStore.getMigration(mapping.physicalTable, sourceId);
          if (existingState) {
            const currentHash = computeContentHash(row);
            if (existingState.contentHash === currentHash) {
              skipCount += 1;
              continue;
            }
            // 内容哈希变化：标记为异常
            stateStore.recordAnomaly({
              sourceTable: mapping.physicalTable,
              sourceId,
              reason: "内容哈希变化（源数据在迁移后被修改）",
              batchId,
              recordedAt: new Date().toISOString(),
            });
            anomalyCount += 1;
            continue;
          }

          // 无转换器：记录为 skipped 状态（支持幂等二次跳过），但不计入 skipCount
          // （无转换器表示该表迁移尚未实现，跳过是预期行为，不作为"已处理跳过"统计）
          if (!transformer) {
            stateStore.recordMigration({
              sourceTable: mapping.physicalTable,
              sourceId,
              contentHash: computeContentHash(row),
              targetTable: "—",
              targetId: "—",
              batchId,
              migratedAt: new Date().toISOString(),
              status: "skipped",
            });
            continue;
          }

          // 执行转换
          const transformResult = await transformer(row);

          if (transformResult.skip) {
            skipCount += 1;
            // 记录跳过状态
            stateStore.recordMigration({
              sourceTable: mapping.physicalTable,
              sourceId,
              contentHash: computeContentHash(row),
              targetTable: "—",
              targetId: "—",
              batchId,
              migratedAt: new Date().toISOString(),
              status: "skipped",
            });
            continue;
          }

          if (transformResult.anomalyReason) {
            // 入异常队列
            stateStore.recordAnomaly({
              sourceTable: mapping.physicalTable,
              sourceId,
              reason: transformResult.anomalyReason,
              batchId,
              recordedAt: new Date().toISOString(),
            });
            anomalyCount += 1;
            // 记录异常状态
            stateStore.recordMigration({
              sourceTable: mapping.physicalTable,
              sourceId,
              contentHash: computeContentHash(row),
              targetTable: "—",
              targetId: "—",
              batchId,
              migratedAt: new Date().toISOString(),
              status: "anomaly",
            });
            continue;
          }

          // dry-run 模式：不写入 V11 目标，只记录
          if (!dryRun && transformResult.targets.length > 0) {
            await this.writeTargets(transformResult.targets);
          }

          targetCount += transformResult.targets.length;

          // 记录迁移状态
          const primaryTarget = transformResult.targets[0];
          stateStore.recordMigration({
            sourceTable: mapping.physicalTable,
            sourceId,
            contentHash: computeContentHash(row),
            targetTable: primaryTarget?.table ?? "—",
            targetId: String(primaryTarget?.data.id ?? sourceId),
            batchId,
            migratedAt: new Date().toISOString(),
            status: "migrated",
          });
        }

        // 更新批次进度
        stateStore.updateBatch(batchId, {
          cursor,
          sourceCount,
          targetCount,
          failureCount,
          anomalyCount,
          skipCount,
        });

        // 不分页模式：一次性读取后结束；分页模式：不足一批时结束
        if (!paginated || rows.length < batchSize) break;
      }

      // 标记批次完成
      const status: MigrationBatch["status"] = failureCount > 0 ? "partial" : "completed";
      stateStore.updateBatch(batchId, {
        status,
        cursor,
        sourceCount,
        targetCount,
        failureCount,
        anomalyCount,
        skipCount,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      failureCount += 1;
      stateStore.updateBatch(batchId, {
        status: "failed",
        cursor,
        sourceCount,
        targetCount,
        failureCount,
        anomalyCount,
        skipCount,
        completedAt: new Date().toISOString(),
        errorMessage,
      });
    }

    const durationMs = Date.now() - startTime;

    return {
      sourceTable: mapping.physicalTable,
      domain: mapping.domain,
      batchId,
      status: stateStore.getBatch(batchId)?.status ?? "failed",
      sourceCount,
      targetCount,
      failureCount,
      anomalyCount,
      skipCount,
      cursor,
      durationMs,
      errorMessage,
    };
  }

  /**
   * 批量写入 V11 目标记录（单事务，保证原子性）。
   * 通过 tableRegistry 查找 drizzle 表对象并执行 db.insert。
   */
  private async writeTargets(targets: readonly TransformTarget[]): Promise<void> {
    const { tableRegistry } = this.options;
    if (!tableRegistry) {
      throw new Error("执行模式需要 tableRegistry（V11 表注册表）");
    }
    await db.transaction(async (tx) => {
      for (const target of targets) {
        const table = getV11Table(target.table) ?? (tableRegistry.get(target.table) as never);
        if (!table) {
          throw new Error(`V11 目标表 ${target.table} 未在 registry 注册`);
        }
        await tx.insert(table as never).values(target.data as never);
      }
    });
  }
}

// ─── 便捷工厂 ──────────────────────────────────────────────

/** 创建 dry-run 运行器（只读，不写入 V11 目标）。 */
export function createDryRunRunner(
  stateStore: MigrationStateStore,
  transformers: ReadonlyMap<string, MigrationTransformer> = new Map(),
  batchSize = 500,
): MigrationRunner {
  return new MigrationRunner({
    stateStore,
    transformers,
    batchSize,
    dryRun: true,
    resume: false,
  });
}

/** 创建执行模式运行器（写入 V11 目标，支持断点续跑）。 */
export function createExecutionRunner(
  stateStore: MigrationStateStore,
  transformers: ReadonlyMap<string, MigrationTransformer>,
  batchSize = 500,
  resume = false,
  tableRegistry?: ReadonlyMap<string, unknown>,
): MigrationRunner {
  return new MigrationRunner({
    stateStore,
    transformers,
    batchSize,
    dryRun: false,
    resume,
    tableRegistry,
  });
}
