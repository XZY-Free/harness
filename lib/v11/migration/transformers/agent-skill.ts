/**
 * S13-C03 agent_skill 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §agent_skill
 * - ../v11-agentkit-platform/10-core-data-model.md §4
 *
 * 映射：
 * - Skill → V11Skill（name→skillKey；status active→enabled/archived→retired；
 *   source local/capability-market→local/capability_market）
 * - SkillVersion → V11SkillVersion（promptTemplate+commitSha→contentRef/contentHash；
 *   status draft/active/archived→draft/published/withdrawn）
 * - SkillSyncMapping → V11SkillVersion（sourceType=capability_market；
 *   remoteAssetId→sourceRef；syncState→revisionState 映射）
 * - Agent → V11Agent + V11AgentRevision（model/skillId 下沉到不可变 Revision；name→agentKey）
 * - SubagentDefinition → V11AgentRevision.delegationPolicyJson（allowedTools→policyJson）
 * - ProviderProfile → V11Connection + V11CredentialRef（apiKeyRef→vaultRef；baseUrl→endpointRef）
 *
 * 迁移原则：
 * - 只迁可证明事实；无法映射的字段入异常队列，不猜测。
 * - 跨表依赖按域顺序保证：Skill → SkillVersion/SkillSyncMapping → Agent → SubagentDefinition → ProviderProfile。
 * - 保留源 id 作为目标 id，便于跨表关联追溯；跨表新建的用 randomUUID()。
 * - contentHash 使用 sha256: 前缀 + hex。
 */
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_USER_ID } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { agent as agentTable } from "@/lib/db/schema";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { v11Agent, v11AgentRevision } from "@/lib/v11/schema/agent";
import { v11Skill, v11SkillVersion } from "@/lib/v11/schema/skill";
import { eq } from "drizzle-orm";

// ─── 辅助函数 ──────────────────────────────────────────────

/** 计算 sha256 内容哈希（sha256: 前缀 + hex）。 */
function computeSha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * 将源记录中的日期值转换为 Date 对象。
 *
 * 原因：migration-runner 通过 `db.execute(sql`SELECT * ...`)` 读取源记录，
 * mysql2 驱动返回 DATETIME 列为字符串（如 "2026-07-24 02:18:17"）而非 Date 对象。
 * drizzle insert 期望 Date 对象（调用 .toISOString() 序列化），故需显式转换。
 *
 * - Date 实例：原样返回。
 * - 字符串：解析为 Date。
 * - null/undefined：返回 null（由调用方决定是否使用默认值）。
 */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return null;
}

/** Skill 状态映射：active→enabled，archived→retired。 */
function mapSkillStatus(status: string): string {
  if (status === "archived") return "retired";
  return "enabled";
}

/** SkillVersion 状态映射：draft→draft，active→published，archived→withdrawn。 */
function mapSkillVersionStatus(status: string): string {
  switch (status) {
    case "draft":
      return "draft";
    case "archived":
      return "withdrawn";
    default:
      return "published";
  }
}

/** SkillSyncMapping syncState → revisionState 映射。 */
function mapSyncState(syncState: string): string {
  switch (syncState) {
    case "active":
      return "published";
    case "blocked":
    case "hidden":
    case "not_found":
      return "withdrawn";
    default:
      return "draft";
  }
}

/** Skill 可见性映射：public→tenant，internal→internal。 */
function mapSkillVisibility(visibility: string): string {
  return visibility === "internal" ? "internal" : "tenant";
}

/** Skill 来源映射：capability-market→capability_market，其余→local。 */
function mapSkillSource(source: string): string {
  return source === "capability-market" ? "capability_market" : "local";
}

// ─── 1. Skill → V11Skill ──────────────────────────────────

const skillTransformer: MigrationTransformer = (record) => {
  const name = String(record.name ?? "");
  if (!name) {
    return { targets: [], anomalyReason: "Skill.name 为空" };
  }

  const status = String(record.status ?? "active");
  const source = String(record.source ?? "local");
  const visibility = String(record.visibility ?? "public");
  const ownerUserId = record.ownerUserId ? String(record.ownerUserId) : DEFAULT_USER_ID;
  const deletedAt = toDate(record.deletedAt);
  const lifecycleState = deletedAt ? "retired" : mapSkillStatus(status);

  return {
    targets: [
      {
        table: "V11Skill",
        data: {
          id: String(record.id),
          tenantId: DEFAULT_TENANT_ID,
          skillKey: name,
          displayName: name,
          description: record.description ? String(record.description) : null,
          ownerUserId,
          lifecycleState,
          currentVersionId: record.currentVersionId ? String(record.currentVersionId) : null,
          visibilityScope: mapSkillVisibility(visibility),
          sourceType: mapSkillSource(source),
          versionNo: 1,
          createdAt: toDate(record.createdAt) ?? new Date(),
          updatedAt: new Date(),
          deletedAt,
        },
      },
    ],
  };
};

// ─── 2. SkillVersion → V11SkillVersion ────────────────────

const skillVersionTransformer: MigrationTransformer = (record) => {
  const skillId = String(record.skillId ?? "");
  if (!skillId) {
    return { targets: [], anomalyReason: "SkillVersion.skillId 为空" };
  }

  const commitSha = record.commitSha ? String(record.commitSha) : "";
  if (!commitSha) {
    return { targets: [], anomalyReason: "SkillVersion.commitSha 为空" };
  }

  const promptTemplate = record.promptTemplate ? String(record.promptTemplate) : "";
  const contentHash = computeSha256(promptTemplate || commitSha);
  const status = String(record.status ?? "active");
  const revisionState = mapSkillVersionStatus(status);

  const manifestJson = {
    promptTemplate: record.promptTemplate ?? null,
    allowedTools: record.allowedTools ?? null,
    requiredCapabilities: record.requiredCapabilities ?? null,
    defaultModelProfile: record.defaultModelProfile ?? null,
    completionCriteria: record.completionCriteria ?? null,
    reviewMode: record.reviewMode ?? null,
    artifactPolicy: record.artifactPolicy ?? null,
    runtimeType: record.runtimeType ?? null,
  };

  return {
    targets: [
      {
        table: "V11SkillVersion",
        data: {
          id: String(record.id),
          skillId,
          versionNo: Number(record.version ?? 1),
          contentRef: commitSha,
          contentHash,
          manifestJson,
          revisionState,
          sourceType: "local",
          sourceRef: null,
          createdBy: DEFAULT_USER_ID,
          createdAt: toDate(record.createdAt) ?? new Date(),
          publishedAt:
            revisionState === "published" ? (toDate(record.createdAt) ?? new Date()) : null,
        },
      },
    ],
  };
};

// ─── 3. SkillSyncMapping → V11SkillVersion (capability_market) ───

const skillSyncMappingTransformer: MigrationTransformer = async (record) => {
  const localSkillId = record.localSkillId ? String(record.localSkillId) : "";
  if (!localSkillId) {
    return { targets: [], anomalyReason: "SkillSyncMapping.localSkillId 为空" };
  }

  // 查询 V11Skill 是否已迁移（须先迁移 Skill）
  const [skillRow] = await db
    .select({ id: v11Skill.id })
    .from(v11Skill)
    .where(eq(v11Skill.id, localSkillId))
    .limit(1);
  if (!skillRow) {
    return {
      targets: [],
      anomalyReason: `localSkillId ${localSkillId} 不存在（须先迁移 Skill）`,
    };
  }

  const remoteAssetId = String(record.remoteAssetId ?? "");
  if (!remoteAssetId) {
    return { targets: [], anomalyReason: "SkillSyncMapping.remoteAssetId 为空" };
  }

  // 查询现有版本号，递增
  const existing = await db
    .select({ versionNo: v11SkillVersion.versionNo })
    .from(v11SkillVersion)
    .where(eq(v11SkillVersion.skillId, localSkillId));
  const maxVersionNo = existing.reduce((max, v) => Math.max(max, v.versionNo), 0);
  const versionNo = maxVersionNo + 1;

  const syncState = String(record.syncState ?? "active");
  const revisionState = mapSyncState(syncState);

  const remoteContentHash = record.remoteContentHash ? String(record.remoteContentHash) : "";
  const contentHash = remoteContentHash.startsWith("sha256:")
    ? remoteContentHash
    : computeSha256(remoteContentHash || remoteAssetId);

  const manifestJson = {
    remoteName: record.remoteName ?? null,
    remoteDisplayName: record.remoteDisplayName ?? null,
    remoteVersion: record.remoteVersion ?? null,
    remoteVersionId: record.remoteVersionId ?? null,
    remoteContentHash: record.remoteContentHash ?? null,
    localName: record.localName ?? null,
    source: record.source ?? "capability-market",
    syncMappingId: String(record.id ?? ""),
  };

  return {
    targets: [
      {
        table: "V11SkillVersion",
        data: {
          id: randomUUID(),
          skillId: localSkillId,
          versionNo,
          contentRef: remoteAssetId,
          contentHash,
          manifestJson,
          revisionState,
          sourceType: "capability_market",
          sourceRef: remoteAssetId,
          createdBy: DEFAULT_USER_ID,
          createdAt: toDate(record.createdAt) ?? new Date(),
          publishedAt:
            revisionState === "published"
              ? (toDate(record.lastSyncedAt) ?? toDate(record.createdAt) ?? new Date())
              : null,
        },
      },
    ],
  };
};

// ─── 4. Agent → V11Agent + V11AgentRevision ───────────────

const agentTransformer: MigrationTransformer = (record) => {
  const name = String(record.name ?? "");
  if (!name) {
    return { targets: [], anomalyReason: "Agent.name 为空" };
  }

  const agentId = String(record.id);
  const revisionId = randomUUID();
  const model = String(record.model ?? "");
  const skillId = record.skillId ? String(record.skillId) : null;
  const deletedAt = toDate(record.deletedAt);
  const lifecycleState = deletedAt ? "retired" : "enabled";
  const createdAt = toDate(record.createdAt) ?? new Date();

  const modelPolicyJson = {
    model,
    skillId,
  };

  return {
    targets: [
      {
        table: "V11Agent",
        data: {
          id: agentId,
          tenantId: DEFAULT_TENANT_ID,
          agentKey: name,
          displayName: name,
          description: record.description ? String(record.description) : null,
          ownerUserId: DEFAULT_USER_ID,
          lifecycleState,
          currentRevisionId: revisionId,
          versionNo: 1,
          createdAt,
          updatedAt: new Date(),
          deletedAt,
        },
      },
      {
        table: "V11AgentRevision",
        data: {
          id: revisionId,
          agentId,
          revisionNo: 1,
          sourceType: "code",
          sourceRevision: `legacy:${agentId}`,
          instructionHash: computeSha256(name),
          agentArtifactRef: `legacy:agent:${agentId}`,
          modelPolicyJson,
          permissionRequirementsJson: {},
          delegationPolicyJson: {},
          agentInterfaceRequirementsJson: {},
          revisionState: "published",
          createdBy: DEFAULT_USER_ID,
          createdAt,
          publishedAt: createdAt,
        },
      },
    ],
  };
};

// ─── 5. SubagentDefinition → V11AgentRevision.delegationPolicyJson ───

const subagentDefinitionTransformer: MigrationTransformer = async (record) => {
  const definitionId = String(record.id ?? "");
  const name = String(record.name ?? "");
  if (!name) {
    return { targets: [], anomalyReason: "SubagentDefinition.name 为空" };
  }

  // 查询引用此 SubagentDefinition 的 Agent（通过 config JSON 匹配 definitionId）
  const agents = await db.select().from(agentTable);
  const relatedAgent = agents.find((a) => {
    const configStr = a.config ? JSON.stringify(a.config) : "";
    return configStr.includes(definitionId);
  });

  if (!relatedAgent) {
    return {
      targets: [],
      anomalyReason: `SubagentDefinition ${definitionId} 无 Agent 引用`,
    };
  }

  // 查询 V11Agent（须先迁移 Agent）
  const [agentRow] = await db
    .select({ id: v11Agent.id })
    .from(v11Agent)
    .where(eq(v11Agent.agentKey, relatedAgent.name))
    .limit(1);
  if (!agentRow) {
    return {
      targets: [],
      anomalyReason: `Agent ${relatedAgent.name} 未迁移（须先迁移 Agent）`,
    };
  }

  // 查询现有 revisionNo，递增
  const existingRevisions = await db
    .select({ revisionNo: v11AgentRevision.revisionNo })
    .from(v11AgentRevision)
    .where(eq(v11AgentRevision.agentId, agentRow.id));
  const maxRevisionNo = existingRevisions.reduce((max, r) => Math.max(max, r.revisionNo), 0);
  const revisionNo = maxRevisionNo + 1;

  const allowedTools = record.allowedTools ?? [];
  const delegationPolicyJson = {
    policyJson: allowedTools,
    source: "subagent_definition",
    definitionId,
    role: record.role ?? null,
  };

  return {
    targets: [
      {
        table: "V11AgentRevision",
        data: {
          id: randomUUID(),
          agentId: agentRow.id,
          revisionNo,
          sourceType: "code",
          sourceRevision: `legacy:subagent:${definitionId}`,
          instructionHash: computeSha256(name),
          agentArtifactRef: `subagent:${definitionId}`,
          modelPolicyJson: {},
          permissionRequirementsJson: {},
          delegationPolicyJson,
          agentInterfaceRequirementsJson: {},
          revisionState: "draft",
          createdBy: DEFAULT_USER_ID,
          createdAt: toDate(record.createdAt) ?? new Date(),
          publishedAt: null,
        },
      },
    ],
  };
};

// ─── 6. ProviderProfile → V11Connection + V11CredentialRef ───

const providerProfileTransformer: MigrationTransformer = (record) => {
  const name = String(record.name ?? "");
  if (!name) {
    return { targets: [], anomalyReason: "ProviderProfile.name 为空" };
  }

  const connectionId = String(record.id);
  const apiKeyRef = String(record.apiKeyRef ?? "");
  const baseUrl = String(record.baseUrl ?? "");
  const createdAt = toDate(record.createdAt) ?? new Date();

  return {
    targets: [
      {
        table: "V11Connection",
        data: {
          id: connectionId,
          tenantId: DEFAULT_TENANT_ID,
          connectionKey: name,
          connectionType: "http",
          endpointRef: baseUrl,
          authMethod: "api_key",
          ownerUserId: DEFAULT_USER_ID,
          lifecycleState: "enabled",
          versionNo: 1,
          createdAt,
          updatedAt: new Date(),
          deletedAt: null,
        },
      },
      {
        table: "V11CredentialRef",
        data: {
          id: randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          connectionId,
          provider: "env",
          vaultRef: apiKeyRef,
          fingerprint: computeSha256(apiKeyRef),
          scopeJson: null,
          expiresAt: null,
          lifecycleState: "active",
          createdAt,
          updatedAt: new Date(),
        },
      },
    ],
  };
};

// ─── 导出 agent_skill 域转换器注册表 ──────────────────────

/** 创建 agent_skill 域的全部转换器（key = 物理表名）。 */
export function createAgentSkillTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["Skill", skillTransformer],
    ["SkillVersion", skillVersionTransformer],
    ["SkillSyncMapping", skillSyncMappingTransformer],
    ["Agent", agentTransformer],
    ["SubagentDefinition", subagentDefinitionTransformer],
    ["ProviderProfile", providerProfileTransformer],
  ]);
}
