import { db } from "@/lib/db/client";
/**
 * S13-W01 迁移映射基线（冻结版本 `migration-mapping-v1`）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §工作包 S13-W01
 *         （为每个旧对象指定 V11 目标、不可迁字段、默认处理、异常队列和验收查询；
 *           识别无法从旧记录证明的状态，统一迁为 unknown/legacy_unverified；
 *           冻结映射版本；迁移期间方案变化必须先更新 V11 方案和本计划，再重新演练）。
 *
 * 完整映射文档：../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md
 */
import { sql } from "drizzle-orm";

/** 冻结的映射版本号；迁移期间方案变化必须升版本并重新演练。 */
export const MAPPING_VERSION = "migration-mapping-v1" as const;

/** 迁移域（按回填顺序排列）。 */
export const MIGRATION_DOMAINS = [
  "identity",
  "agent_skill",
  "conversation",
  "runtime_fact",
  "policy",
  "context_plan",
  "background_subagent",
  "memory",
  "mcp_tool",
  "deployment_secret",
  "git_checkpoint",
  "misc",
] as const;
export type MigrationDomain = (typeof MIGRATION_DOMAINS)[number];

/** 旧表 → V11 目标映射定义。 */
export interface LegacyTableMapping {
  /** 旧表逻辑名（用于报告，非 SQL 表名）。 */
  readonly legacyTable: string;
  /** MySQL 物理表名。 */
  readonly physicalTable: string;
  /** V11 目标表逻辑名（可多个）。 */
  readonly v11Targets: readonly string[];
  /** 迁移域。 */
  readonly domain: MigrationDomain;
  /** 迁移顺序（域内序号）。 */
  readonly order: number;
  /** 不可迁字段（敏感或中间态，迁移时跳过）。 */
  readonly unmigratableFields: readonly string[];
  /** 默认处理规则描述。 */
  readonly defaultHandling: string;
  /** 异常队列条件描述（满足时入异常队列不迁移）。 */
  readonly anomalyConditions: string;
  /** 是否核心实体（非核心可跳过）。 */
  readonly coreEntity: boolean;
  /**
   * 游标分页列（物理列名）。
   * - 默认 "id"：按该列升序游标分页。
   * - 空字符串 ""：表无单一可排序唯一列（如复合主键关联表），一次性读取不分页。
   * - 其他值如 "key"：按该列游标分页。
   */
  readonly cursorColumn?: string;
  /**
   * 构成源记录唯一标识的物理列（用于幂等键 sourceId）。
   * - 默认 ["id"]：sourceId = row.id。
   * - 多列如 ["roleId", "permission"]：sourceId = `${roleId}::${permission}`。
   */
  readonly idColumns?: readonly string[];
}

/** 38 张旧表的完整映射基线（按迁移顺序排列）。 */
export const MAPPING_BASELINE: readonly LegacyTableMapping[] = [
  // ── identity（域 1）──────────────────────────────────────
  {
    legacyTable: "User",
    physicalTable: "User",
    v11Targets: ["UserIdentity", "PrincipalBinding"],
    domain: "identity",
    order: 1,
    unmigratableFields: [],
    defaultHandling: "externalId→externalSubject；无 email 的迁为 legacy_unverified",
    anomalyConditions: "externalId 为空",
    coreEntity: true,
  },
  {
    legacyTable: "Role",
    physicalTable: "Role",
    v11Targets: ["RoleActionBinding"],
    domain: "identity",
    order: 2,
    unmigratableFields: [],
    defaultHandling: "admin→admin.* action set；member→member.* action set",
    anomalyConditions: "—",
    coreEntity: true,
  },
  {
    legacyTable: "RolePermission",
    physicalTable: "RolePermission",
    v11Targets: ["RoleActionBinding"],
    domain: "identity",
    order: 3,
    unmigratableFields: [],
    defaultHandling: "permission→ACTION_CODES 映射；无法映射的入异常队列",
    anomalyConditions: "permission 不在 ACTION_CODES 目录",
    coreEntity: true,
    // 复合唯一键 (roleId, permission)，无单一 id 列；不分页一次性读取
    cursorColumn: "",
    idColumns: ["roleId", "permission"],
  },
  {
    legacyTable: "UserRole",
    physicalTable: "UserRole",
    v11Targets: ["PrincipalBinding"],
    domain: "identity",
    order: 4,
    unmigratableFields: [],
    defaultHandling: "userId→userIdentityId",
    anomalyConditions: "userId 不存在",
    coreEntity: true,
    // 复合唯一键 (userId, roleId)，无单一 id 列；不分页一次性读取
    cursorColumn: "",
    idColumns: ["userId", "roleId"],
  },

  // ── agent_skill（域 2）───────────────────────────────────
  {
    legacyTable: "Skill",
    physicalTable: "Skill",
    v11Targets: ["V11Skill"],
    domain: "agent_skill",
    order: 1,
    unmigratableFields: ["activeSkillId"],
    defaultHandling: "name→skillKey；status→lifecycleState",
    anomalyConditions: "name 重复",
    coreEntity: true,
  },
  {
    legacyTable: "SkillVersion",
    physicalTable: "SkillVersion",
    v11Targets: ["V11SkillVersion"],
    domain: "agent_skill",
    order: 2,
    unmigratableFields: ["allowedTools"],
    defaultHandling: "promptTemplate→manifestJson + contentRef(commitSha)；status→revisionState",
    anomalyConditions: "commitSha 为空",
    coreEntity: true,
  },
  {
    legacyTable: "SkillSyncMapping",
    physicalTable: "SkillSyncMapping",
    v11Targets: ["V11SkillVersion.sourceType=capability_market"],
    domain: "agent_skill",
    order: 3,
    unmigratableFields: [],
    defaultHandling: "remoteAssetId→sourceRef；syncState→revisionState 映射",
    anomalyConditions: "localSkillId 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "Agent",
    physicalTable: "Agent",
    v11Targets: ["V11Agent", "V11AgentRevision"],
    domain: "agent_skill",
    order: 4,
    unmigratableFields: ["config"],
    defaultHandling: "model/skillId 下沉到不可变 Revision；新增 agentKey",
    anomalyConditions: "name 重复",
    coreEntity: true,
  },
  {
    legacyTable: "SubagentDefinition",
    physicalTable: "SubagentDefinition",
    v11Targets: ["V11AgentRevision.delegationPolicyJson"],
    domain: "agent_skill",
    order: 5,
    unmigratableFields: ["modelProfileId"],
    defaultHandling: "子代理模板→Agent 委派策略；allowedTools→policyJson",
    anomalyConditions: "name 重复",
    coreEntity: true,
  },
  {
    legacyTable: "ProviderProfile",
    physicalTable: "ProviderProfile",
    v11Targets: ["V11Connection", "V11CredentialRef"],
    domain: "agent_skill",
    order: 6,
    unmigratableFields: ["apiKeyRef"],
    defaultHandling: "apiKeyRef→CredentialRef.vaultRef；baseUrl→endpointRef",
    anomalyConditions: "name 重复",
    coreEntity: true,
  },

  // ── conversation（域 3）──────────────────────────────────
  {
    legacyTable: "Thread",
    physicalTable: "Thread",
    v11Targets: ["V11Thread"],
    domain: "conversation",
    order: 1,
    unmigratableFields: ["cicdApiToken"],
    defaultHandling: "status→lifecycleState；previewUrl→artifactRef",
    anomalyConditions: "status=deleted 且无 deletedAt",
    coreEntity: true,
  },
  {
    legacyTable: "Message",
    physicalTable: "Message",
    v11Targets: ["V11ThreadItem"],
    domain: "conversation",
    order: 2,
    unmigratableFields: [],
    defaultHandling: "parts→contentJson；role/type→itemType；runId→invocationId",
    anomalyConditions: "threadId 不存在（孤儿消息）",
    coreEntity: true,
  },
  {
    legacyTable: "ThreadEvent",
    physicalTable: "ThreadEvent",
    v11Targets: ["V11ThreadEvent"],
    domain: "conversation",
    order: 3,
    unmigratableFields: [],
    defaultHandling: "sequence→eventSequence(bigint)；payload→payloadJson；type→eventType",
    anomalyConditions: "threadId 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "ThreadRun",
    physicalTable: "ThreadRun",
    v11Targets: ["V11Invocation", "V11InvocationAttempt"],
    domain: "conversation",
    order: 4,
    unmigratableFields: [],
    defaultHandling: "status→invocationState；triggerType→triggerSource",
    anomalyConditions: "threadId 不存在",
    coreEntity: true,
  },

  // ── runtime_fact（域 4）──────────────────────────────────
  {
    legacyTable: "ToolRun",
    physicalTable: "ToolRun",
    v11Targets: ["V11ToolCall"],
    domain: "runtime_fact",
    order: 1,
    unmigratableFields: [],
    defaultHandling: "status→callState；input/output→inputJson/outputJson",
    anomalyConditions: "threadId 或 runId 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "RunTranscriptChunk",
    physicalTable: "RunTranscriptChunk",
    v11Targets: ["V11RuntimeEventIngress"],
    domain: "runtime_fact",
    order: 2,
    unmigratableFields: [],
    defaultHandling: "kind→ingressKind；payload→payloadJson + payloadHash",
    anomalyConditions: "runId 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "ThreadRunSkill",
    physicalTable: "ThreadRunSkill",
    v11Targets: ["V11ExecutionBinding"],
    domain: "runtime_fact",
    order: 3,
    unmigratableFields: [],
    defaultHandling: "skillId/skillVersionId→agentRevisionId（经 Skill 迁移映射）",
    anomalyConditions: "skillId 不在迁移映射",
    coreEntity: true,
  },
  {
    legacyTable: "ContextSnapshot",
    physicalTable: "ContextSnapshot",
    v11Targets: ["V11ContextCheckpoint"],
    domain: "runtime_fact",
    order: 4,
    unmigratableFields: ["skillResolverInput", "skillResolverOutput"],
    defaultHandling: "layers→contextLayersJson；checksums→checksumJson",
    anomalyConditions: "runId 不存在",
    coreEntity: true,
  },

  // ── policy（域 5）────────────────────────────────────────
  {
    legacyTable: "PolicyConfig",
    physicalTable: "PolicyConfig",
    v11Targets: ["V11PolicySet", "V11PolicyRevision"],
    domain: "policy",
    order: 1,
    unmigratableFields: [],
    defaultHandling: "KV→版本化策略修订",
    anomalyConditions: "key 无法映射",
    coreEntity: true,
    // 主键为 key（varchar），无 id 列；按 key 游标分页
    cursorColumn: "key",
    idColumns: ["key"],
  },
  {
    legacyTable: "PolicyConfigHistory",
    physicalTable: "PolicyConfigHistory",
    v11Targets: ["AuditEvent"],
    domain: "policy",
    order: 2,
    unmigratableFields: ["beforeSnapshot", "afterSnapshot"],
    defaultHandling: "变更历史并入审计账本；只保留 changedKeys + hash",
    anomalyConditions: "—",
    coreEntity: false,
  },
  {
    legacyTable: "ToolPermissionRule",
    physicalTable: "ToolPermissionRule",
    v11Targets: ["V11PermissionDecision", "V11Policy"],
    domain: "policy",
    order: 3,
    unmigratableFields: [],
    defaultHandling: "decision: allow/deny/ask → allow/pause/block",
    anomalyConditions: "scope 无法映射",
    coreEntity: true,
  },
  {
    legacyTable: "ToolApprovalRequest",
    physicalTable: "ToolApprovalRequest",
    v11Targets: ["V11UserActionRequest", "V11PermissionDecision"],
    domain: "policy",
    order: 4,
    unmigratableFields: [],
    defaultHandling: "status→requestState；approvedScope→decisionScope",
    anomalyConditions: "threadId 或 toolRunId 不存在",
    coreEntity: true,
  },

  // ── context_plan（域 6）──────────────────────────────────
  {
    legacyTable: "ContextSummary",
    physicalTable: "ContextSummary",
    v11Targets: ["V11ContextCheckpoint"],
    domain: "context_plan",
    order: 1,
    unmigratableFields: [],
    defaultHandling: "summaryText→summaryJson；supersededById 保留",
    anomalyConditions: "threadId 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "ThreadPlan",
    physicalTable: "ThreadPlan",
    v11Targets: ["V11Goal"],
    domain: "context_plan",
    order: 2,
    unmigratableFields: [],
    defaultHandling: "status→goalState；source→sourceType",
    anomalyConditions: "threadId 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "ThreadPlanItem",
    physicalTable: "ThreadPlanItem",
    v11Targets: ["V11Goal", "V11ThreadItem"],
    domain: "context_plan",
    order: 3,
    unmigratableFields: ["evidence"],
    defaultHandling: "status→itemState；evidence→evidenceJson",
    anomalyConditions: "planId 不存在",
    coreEntity: true,
  },

  // ── background_subagent（域 7）───────────────────────────
  {
    legacyTable: "BackgroundTask",
    physicalTable: "BackgroundTask",
    v11Targets: ["V11Job", "V11Invocation"],
    domain: "background_subagent",
    order: 1,
    unmigratableFields: ["pid", "containerName", "port", "logPath"],
    defaultHandling: "kind→jobType；status→jobState",
    anomalyConditions: "threadId 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "SubagentRun",
    physicalTable: "SubagentRun",
    v11Targets: ["V11ThreadRelation", "V11Invocation"],
    domain: "background_subagent",
    order: 2,
    unmigratableFields: ["transcriptPath"],
    defaultHandling: "status→relationState；parentThreadId→parentThreadId",
    anomalyConditions: "parentThreadId 不存在",
    coreEntity: true,
  },

  // ── memory（域 8）────────────────────────────────────────
  {
    legacyTable: "MemoryEntry",
    physicalTable: "MemoryEntry",
    v11Targets: ["V11MemoryEntry", "V11MemoryCandidate"],
    domain: "memory",
    order: 1,
    unmigratableFields: [],
    defaultHandling: "scope→scopeType；kind→entryKind；status→entryState",
    anomalyConditions: "scopeRef 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "MemoryEmbedding",
    physicalTable: "MemoryEmbedding",
    v11Targets: ["V11MemoryIndex"],
    domain: "memory",
    order: 2,
    unmigratableFields: ["vector"],
    defaultHandling: "vector→indexRef；provider/model 保留；status→indexState",
    anomalyConditions: "memoryId 不存在",
    coreEntity: true,
  },

  // ── mcp_tool（域 9）──────────────────────────────────────
  {
    legacyTable: "McpServerConfig",
    physicalTable: "McpServerConfig",
    v11Targets: ["V11Connection", "V11ToolProvider"],
    domain: "mcp_tool",
    order: 1,
    unmigratableFields: ["env"],
    defaultHandling: "name→connectionKey；env→CredentialRef；tools→V11Tool",
    anomalyConditions: "name 重复",
    coreEntity: true,
  },
  {
    legacyTable: "CustomTool",
    physicalTable: "CustomTool",
    v11Targets: ["V11ToolProvider", "V11Tool", "V11ToolSchemaRevision"],
    domain: "mcp_tool",
    order: 2,
    unmigratableFields: [],
    defaultHandling: "inputSchema→ToolSchemaRevision；executorConfig→Connection",
    anomalyConditions: "name 重复",
    coreEntity: true,
  },

  // ── deployment_secret（域 10）────────────────────────────
  {
    legacyTable: "Deployment",
    physicalTable: "Deployment",
    v11Targets: ["V11DeploymentRoute"],
    domain: "deployment_secret",
    order: 1,
    unmigratableFields: ["cicdJobUrl"],
    defaultHandling: "environment→environmentTag；commitSha→artifactRef；status→routeState",
    anomalyConditions: "threadId 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "SecretMount",
    physicalTable: "SecretMount",
    v11Targets: ["V11CredentialRef", "V11Grant"],
    domain: "deployment_secret",
    order: 2,
    unmigratableFields: ["ciphertext"],
    defaultHandling: "ciphertext→Vault 引用；scope→Grant.scopeJson",
    anomalyConditions: "scopeRef 不存在",
    coreEntity: true,
  },

  // ── git_checkpoint（域 11）───────────────────────────────
  {
    legacyTable: "GitCheckpoint",
    physicalTable: "GitCheckpoint",
    v11Targets: ["V11FilesystemCheckpoint", "V11ArtifactAttestation"],
    domain: "git_checkpoint",
    order: 1,
    unmigratableFields: [],
    defaultHandling: "tag/commitSha→制品证明；filesChanged→changeListJson",
    anomalyConditions: "threadId 不存在",
    coreEntity: true,
  },

  // ── misc（域 12）─────────────────────────────────────────
  {
    legacyTable: "ChatExample",
    physicalTable: "ChatExample",
    v11Targets: [],
    domain: "misc",
    order: 1,
    unmigratableFields: [],
    defaultHandling: "无直接对应；改 env/seed 或迁入 V11 catalog 配置；非核心实体",
    anomalyConditions: "—",
    coreEntity: false,
  },
  {
    legacyTable: "AuditFailureLog",
    physicalTable: "AuditFailureLog",
    v11Targets: ["V11RuntimeEventIngress", "AuditEvent"],
    domain: "misc",
    order: 2,
    unmigratableFields: ["payload"],
    defaultHandling: "审计失败重试→事件账本 reject 通道",
    anomalyConditions: "—",
    coreEntity: false,
  },
  {
    legacyTable: "DesktopDevice",
    physicalTable: "DesktopDevice",
    v11Targets: ["V11Device"],
    domain: "misc",
    order: 3,
    unmigratableFields: ["publicKey"],
    defaultHandling: "deviceId→deviceKey；status→deviceState；userId→userIdentityId",
    anomalyConditions: "userId 不存在",
    coreEntity: true,
  },
  {
    legacyTable: "AdminAuditLog",
    physicalTable: "AdminAuditLog",
    v11Targets: ["AuditEvent"],
    domain: "misc",
    order: 4,
    unmigratableFields: ["metadata"],
    defaultHandling: "action→actionType 目录化；outcome→隐含于 action；metadata→before/afterHash",
    anomalyConditions: "action 不在 AUDIT_ACTION_TYPES",
    coreEntity: true,
  },
];

/** 按域分组返回映射。 */
export function getMappingsByDomain(domain: MigrationDomain): readonly LegacyTableMapping[] {
  return MAPPING_BASELINE.filter((m) => m.domain === domain).sort((a, b) => a.order - b.order);
}

/** 按迁移顺序返回所有核心实体映射。 */
export function getCoreEntityMappings(): readonly LegacyTableMapping[] {
  return MAPPING_BASELINE.filter((m) => m.coreEntity);
}

/** 按物理表名查找映射。 */
export function getMappingByPhysicalTable(physicalTable: string): LegacyTableMapping | undefined {
  return MAPPING_BASELINE.find((m) => m.physicalTable === physicalTable);
}

/** 统计映射覆盖的旧表总数。 */
export function getMappingCount(): number {
  return MAPPING_BASELINE.length;
}

/** 统计核心实体旧表数。 */
export function getCoreEntityCount(): number {
  return MAPPING_BASELINE.filter((m) => m.coreEntity).length;
}

/** 统计非核心实体旧表数（可跳过）。 */
export function getNonCoreEntityCount(): number {
  return MAPPING_BASELINE.filter((m) => !m.coreEntity).length;
}

// ─── 游标与源 ID 解析 ──────────────────────────────────────

/** 默认游标分页列。 */
export const DEFAULT_CURSOR_COLUMN = "id" as const;

/** 默认源 ID 列。 */
export const DEFAULT_ID_COLUMNS = ["id"] as const;

/** 返回映射的有效游标列（默认 "id"；空字符串表示不分页）。 */
export function getCursorColumn(mapping: LegacyTableMapping): string {
  return mapping.cursorColumn ?? DEFAULT_CURSOR_COLUMN;
}

/** 返回映射的有效源 ID 列（默认 ["id"]）。 */
export function getIdColumns(mapping: LegacyTableMapping): readonly string[] {
  return mapping.idColumns ?? DEFAULT_ID_COLUMNS;
}

/** 是否对该表启用游标分页（cursorColumn 为空字符串时不分页）。 */
export function isPaginated(mapping: LegacyTableMapping): boolean {
  return getCursorColumn(mapping) !== "";
}

/**
 * 从源记录行生成稳定的 sourceId（幂等键）。
 * 多列时以 "::" 拼接，单列时直接取值。
 */
export function buildSourceId(mapping: LegacyTableMapping, row: Record<string, unknown>): string {
  const cols = getIdColumns(mapping);
  const values = cols.map((c) => String(row[c] ?? ""));
  return values.join("::");
}

// ─── 盘点查询工具 ──────────────────────────────────────────

/** 单张旧表的盘点结果。 */
export interface TableInventory {
  /** 旧表逻辑名。 */
  readonly legacyTable: string;
  /** MySQL 物理表名。 */
  readonly physicalTable: string;
  /** 迁移域。 */
  readonly domain: MigrationDomain;
  /** 行数。 */
  readonly rowCount: number;
  /** 最早 createdAt（ISO 字符串，无数据为 null）。 */
  readonly earliestAt: string | null;
  /** 最晚 createdAt（ISO 字符串，无数据为 null）。 */
  readonly latestAt: string | null;
  /** 是否核心实体。 */
  readonly coreEntity: boolean;
}

/** 查询单张旧表的行数和时间范围。 */
export async function getTableInventory(mapping: LegacyTableMapping): Promise<TableInventory> {
  const tableName = mapping.physicalTable;
  const [countRows] = (await db.execute(
    sql`SELECT COUNT(*) as total FROM ${sql.raw(`\`${tableName}\``)}`,
  )) as unknown as [{ total: number }[]];
  const rowCount = countRows[0]?.total ?? 0;

  let earliestAt: string | null = null;
  let latestAt: string | null = null;

  if (rowCount > 0) {
    const [timeRows] = (await db.execute(sql`
      SELECT MIN(\`createdAt\`) as earliest, MAX(\`createdAt\`) as latest FROM ${sql.raw(`\`${tableName}\``)}
    `)) as unknown as [{ earliest: string | null; latest: string | null }[]];
    earliestAt = timeRows[0]?.earliest ?? null;
    latestAt = timeRows[0]?.latest ?? null;
  }

  return {
    legacyTable: mapping.legacyTable,
    physicalTable: mapping.physicalTable,
    domain: mapping.domain,
    rowCount,
    earliestAt,
    latestAt,
    coreEntity: mapping.coreEntity,
  };
}

/** 查询所有旧表的盘点结果。 */
export async function getFullInventory(): Promise<TableInventory[]> {
  const results: TableInventory[] = [];
  for (const mapping of MAPPING_BASELINE) {
    try {
      const inventory = await getTableInventory(mapping);
      results.push(inventory);
    } catch (err) {
      // 表不存在或查询失败时记录零值
      results.push({
        legacyTable: mapping.legacyTable,
        physicalTable: mapping.physicalTable,
        domain: mapping.domain,
        rowCount: 0,
        earliestAt: null,
        latestAt: null,
        coreEntity: mapping.coreEntity,
      });
    }
  }
  return results;
}

/** 盘点汇总报告。 */
export interface InventoryReport {
  /** 映射版本。 */
  readonly mappingVersion: typeof MAPPING_VERSION;
  /** 生成时间（ISO 字符串）。 */
  readonly generatedAt: string;
  /** 旧表总数。 */
  readonly totalTables: number;
  /** 核心实体表数。 */
  readonly coreEntityTables: number;
  /** 总行数。 */
  readonly totalRows: number;
  /** 按域汇总。 */
  readonly byDomain: ReadonlyArray<{
    readonly domain: MigrationDomain;
    readonly tableCount: number;
    readonly totalRows: number;
    readonly tables: ReadonlyArray<TableInventory>;
  }>;
  /** 全部表明细。 */
  readonly tables: readonly TableInventory[];
}

/** 生成完整盘点报告。 */
export async function generateInventoryReport(): Promise<InventoryReport> {
  const tables = await getFullInventory();
  const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0);
  const coreEntityTables = tables.filter((t) => t.coreEntity).length;

  const byDomain = MIGRATION_DOMAINS.map((domain) => {
    const domainTables = tables.filter((t) => t.domain === domain);
    return {
      domain,
      tableCount: domainTables.length,
      totalRows: domainTables.reduce((sum, t) => sum + t.rowCount, 0),
      tables: domainTables,
    };
  });

  return {
    mappingVersion: MAPPING_VERSION,
    generatedAt: new Date().toISOString(),
    totalTables: tables.length,
    coreEntityTables,
    totalRows,
    byDomain,
    tables,
  };
}
