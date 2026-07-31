/**
 * S13-C03 deployment_secret 域 + git_checkpoint 域迁移转换器（合并文件）。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §2.11（部署与密钥）、§2.12（Git 检查点）
 * - ../v11-agentkit-platform/10-core-data-model.md §4.3（DeploymentRoute）、§6.8（Grant）、§7.3（FilesystemCheckpoint）、§8.2（ArtifactAttestation）
 *
 * 映射：
 * - Deployment → V11DeploymentRouteSet + V11DeploymentRoute
 *   - environment→routeScopeKey（environmentTag）；commitSha→routeScopeJson.artifactRef；status→routeState
 *   - threadId 不存在入异常队列；cicdJobUrl 不迁（unmigratableFields）
 *   - 旧 Deployment 无 Agent/Runtime Revision 概念，agentRevisionId/runtimeRevisionId 用占位值（无 DB FK 约束）
 * - SecretMount → V11CredentialRef + V11Grant
 *   - ciphertext 不迁（unmigratableFields），用 legacy-vault 引用代替；scope→Grant.scopeJson
 *   - scopeRef 为空入异常队列
 * - GitCheckpoint → V11FilesystemCheckpoint + V11ArtifactAttestation
 *   - tag/commitSha→制品证明（sourceRevision/artifactDigest）；filesChanged→scanSummaryJson.changeList
 *   - threadId 不存在入异常队列
 *
 * 迁移原则：
 * - 只迁可证明事实；无法映射的字段统一迁为占位值或入异常队列，不猜测。
 * - 跨表依赖按域顺序保证：Deployment → SecretMount；GitCheckpoint 独立。
 * - 保留源 id 作为主目标 id（V11DeploymentRoute/V11CredentialRef/V11FilesystemCheckpoint），便于跨表关联追溯。
 * - 次目标（RouteSet/Grant/ArtifactAttestation/Workspace）用新 id。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { thread as threadTable } from "@/lib/db/schema";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer, TransformTarget } from "@/lib/v11/migration/migration-runner";
import { workspaceBinding as v11WorkspaceBinding } from "@/lib/v11/schema/workspace";
import { eq } from "drizzle-orm";

// ─── 占位 ID ───────────────────────────────────────────────
// 旧数据无对应概念，V11 字段为逻辑外键（无 DB FK 约束）时可安全写入占位值。

/** 旧 Deployment 无 Agent 概念，V11DeploymentRouteSet.agentId 占位。 */
const LEGACY_AGENT_ID = "00000000-0000-4000-8000-0000000000a0";
/** 旧 Deployment 无 Runtime Revision 概念，V11DeploymentRoute.runtimeRevisionId 占位。 */
const LEGACY_RUNTIME_REVISION_ID = "00000000-0000-4000-8000-0000000000a1";
/** 旧 SecretMount 无用户概念，V11Grant.userId 占位（逻辑外键，无 DB FK 约束）。 */
const LEGACY_SYSTEM_USER_ID = "00000000-0000-4000-8000-0000000000b0";
/** 旧 GitCheckpoint 无 Invocation 概念，V11FilesystemCheckpoint.invocationId 占位（逻辑外键）。 */
const LEGACY_INVOCATION_ID = "00000000-0000-4000-8000-0000000000c0";

// 旧 GitCheckpoint 无 Workspace 概念，所有 checkpoint 共享一组 legacy workspace/binding。
// V11FilesystemCheckpoint.workspaceBindingId 为 DB 级 FK（→ V11WorkspaceBinding.id），须引用真实行。
const LEGACY_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000d0";
const LEGACY_WORKSPACE_BINDING_ID = "00000000-0000-4000-8000-0000000000d1";
const LEGACY_WORKSPACE_KEY = "legacy-git-checkpoint-workspace";

// ─── toDate 辅助函数 ───────────────────────────────────────

/**
 * 将 Date 值规范化（兼容 string/Date 输入）。
 *
 * 关键：迁移 runner 通过 db.execute 原始 SQL 读取源记录，drizzle mysql2 session 的 typeCast
 * 将 DATETIME/TIMESTAMP/DATE 列统一返回为字符串。该字符串是 UTC 表示，必须按 UTC 解析
 * （与 drizzle mapFromDriverValue 一致）；若直接 new Date(str) 会按本地时区解析，导致时区偏移。
 */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const str = String(value);
  // 形如 "2024-06-01 12:00:00" 或 "2024-06-01 12:00:00.000"（drizzle typeCast 返回的 DATETIME 串）
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(str)) {
    return new Date(`${str.replace(" ", "T")}Z`);
  }
  return new Date(str);
}

/** 计算 sha256 hex 摘要。 */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 计算 V11 contentHash（sha256: 前缀 + 64 hex）。 */
function toContentHash(input: string): string {
  return `sha256:${sha256Hex(input)}`;
}

// ═══════════════════════════════════════════════════════════
// deployment_secret 域
// ═══════════════════════════════════════════════════════════

// ─── Deployment status → V11DeploymentRoute routeState ─────

/** 映射 Deployment.status → V11DeploymentRoute.routeState；deployed 为有效，其余禁用。 */
function mapDeploymentStatusToRouteState(status: string): "enabled" | "disabled" {
  return status === "deployed" ? "enabled" : "disabled";
}

// ─── Deployment → V11DeploymentRouteSet + V11DeploymentRoute ─

const deploymentTransformer: MigrationTransformer = async (record) => {
  const deploymentId = String(record.id ?? "");
  if (!deploymentId) {
    return { targets: [], anomalyReason: "Deployment.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "Deployment.threadId 为空" };
  }

  // 验证 threadId 存在（查询旧 Thread 表）
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  if (!threadRow) {
    return { targets: [], anomalyReason: `Thread ${threadId} 不存在` };
  }

  const environment = String(record.environment ?? "");
  if (!environment) {
    return { targets: [], anomalyReason: "Deployment.environment 为空" };
  }

  const commitSha = record.commitSha ? String(record.commitSha) : null;
  const status = String(record.status ?? "pending");
  const routeState = mapDeploymentStatusToRouteState(status);
  const createdAt = toDate(record.createdAt);
  const deployedAt = record.deployedAt ? toDate(record.deployedAt) : null;
  const rolledBackAt = record.rolledBackAt ? toDate(record.rolledBackAt) : null;

  // 一个 Deployment 对应一个 RouteSet（旧数据无 Agent 分组概念，不猜测合并；
  // routeScopeKey 含 deploymentId 以满足 UNIQUE(tenantId, agentId, routeScopeKey)）
  const routeSetId = randomUUID();
  const routeScopeKey = `${environment}:${deploymentId}`;

  return {
    targets: [
      {
        table: "V11DeploymentRouteSet",
        data: {
          id: routeSetId,
          tenantId: DEFAULT_TENANT_ID,
          agentId: LEGACY_AGENT_ID,
          routeScopeKey,
          // environmentTag 保留原始 environment；commitSha 作为 artifactRef 携带（cicdJobUrl 不迁）
          routeScopeJson: {
            environmentTag: environment,
            threadId,
            artifactRef: commitSha,
          },
          versionNo: 1,
          createdAt,
          updatedAt: createdAt,
        },
      },
      {
        table: "V11DeploymentRoute",
        data: {
          id: deploymentId,
          routeSetId,
          // 旧数据无 Agent/Runtime Revision 概念；用占位值（V11DeploymentRoute 无 DB FK 约束）
          agentRevisionId: LEGACY_AGENT_ID,
          runtimeRevisionId: LEGACY_RUNTIME_REVISION_ID,
          trafficWeight: 10000,
          priorityNo: 0,
          routeState,
          effectiveFrom: deployedAt,
          effectiveUntil: rolledBackAt,
          createdAt,
          updatedAt: createdAt,
        },
      },
    ],
  };
};

// ─── SecretMount status → V11CredentialRef lifecycleState ─

/** 映射 SecretMount.status/rotatedAt → V11CredentialRef.lifecycleState。 */
function mapSecretMountLifecycleState(
  status: string,
  rotatedAt: unknown,
): "active" | "rotated" | "revoked" {
  if (status === "revoked") return "revoked";
  if (rotatedAt !== null && rotatedAt !== undefined) return "rotated";
  return "active";
}

// ─── SecretMount → V11CredentialRef + V11Grant ─────────────

const secretMountTransformer: MigrationTransformer = (record) => {
  const id = String(record.id ?? "");
  if (!id) {
    return { targets: [], anomalyReason: "SecretMount.id 为空" };
  }

  const scope = String(record.scope ?? "");
  // scopeRef 为空入异常队列（无法确定作用域绑定）
  const scopeRef = record.scopeRef != null ? String(record.scopeRef) : "";
  if (!scopeRef) {
    return { targets: [], anomalyReason: "scopeRef 为空（无法确定作用域绑定）" };
  }

  const name = String(record.name ?? "");
  const keyId = String(record.keyId ?? "");
  const status = String(record.status ?? "active");
  const createdAt = toDate(record.createdAt);
  const updatedAt = toDate(record.updatedAt);
  const rotatedAt = record.rotatedAt ? toDate(record.rotatedAt) : null;
  const lifecycleState = mapSecretMountLifecycleState(status, record.rotatedAt);

  // ciphertext 不迁（unmigratableFields），用 legacy-vault 引用代替（含 keyId 保留轮换元数据）
  const vaultRef = `legacy-vault://SecretMount/${id}?key=${encodeURIComponent(keyId)}`;
  // ciphertext 不迁，无法计算真实指纹；用源 id 占位指纹（sha256 前缀，满足脱敏比对格式）
  const fingerprint = toContentHash(id);
  // scope→scopeJson：拼接 scope:scopeRef 作为凭证 scope
  const scopeJson = [`${scope}:${scopeRef}`];

  // V11Grant.userId 为逻辑外键（无 DB FK 约束），旧 SecretMount 无用户概念，用占位值
  const grantState: "active" | "revoked" = status === "revoked" ? "revoked" : "active";
  const grantRevokedAt = status === "revoked" ? updatedAt : null;

  return {
    targets: [
      {
        table: "V11CredentialRef",
        data: {
          id,
          tenantId: DEFAULT_TENANT_ID,
          connectionId: null,
          provider: "vault",
          vaultRef,
          fingerprint,
          scopeJson,
          expiresAt: null,
          lifecycleState,
          createdAt,
          updatedAt,
        },
      },
      {
        table: "V11Grant",
        data: {
          id: randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          userId: LEGACY_SYSTEM_USER_ID,
          grantType: "policy",
          // scope→Grant.scopeJson
          scopeJson,
          credentialRefId: id,
          issuedBy: "legacy-migration",
          issuedAt: createdAt,
          expiresAt: null,
          revokedAt: grantRevokedAt,
          revokeReasonCode: null,
          grantState,
          versionNo: 1,
          createdAt,
          updatedAt,
        },
      },
    ],
  };
};

// ═══════════════════════════════════════════════════════════
// git_checkpoint 域
// ═══════════════════════════════════════════════════════════

/**
 * 确保 legacy workspace binding 存在（V11FilesystemCheckpoint.workspaceBindingId 为 DB 级 FK）。
 * 返回 [targets, workspaceBindingId]：首条 checkpoint 创建共享 workspace+binding，后续复用。
 */
async function ensureLegacyWorkspaceBinding(): Promise<{
  readonly targets: readonly import("@/lib/v11/migration/migration-runner").TransformTarget[];
  readonly workspaceBindingId: string;
}> {
  const [existing] = await db
    .select({ id: v11WorkspaceBinding.id })
    .from(v11WorkspaceBinding)
    .where(eq(v11WorkspaceBinding.id, LEGACY_WORKSPACE_BINDING_ID))
    .limit(1);
  if (existing) {
    return { targets: [], workspaceBindingId: LEGACY_WORKSPACE_BINDING_ID };
  }
  const now = new Date();
  return {
    targets: [
      {
        table: "V11Workspace",
        data: {
          id: LEGACY_WORKSPACE_ID,
          tenantId: DEFAULT_TENANT_ID,
          ownerUserId: null,
          workspaceKey: LEGACY_WORKSPACE_KEY,
          displayName: "Legacy Git Checkpoint Workspace",
          description:
            "迁移占位 Workspace：承载旧 GitCheckpoint 的 FilesystemCheckpoint（旧数据无 Workspace 概念）",
          workspaceKind: "system",
          lifecycleState: "active",
          defaultEnvironmentDefinitionId: null,
          defaultBindingId: LEGACY_WORKSPACE_BINDING_ID,
          versionNo: randomUUID(),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      },
      {
        table: "V11WorkspaceBinding",
        data: {
          id: LEGACY_WORKSPACE_BINDING_ID,
          tenantId: DEFAULT_TENANT_ID,
          workspaceId: LEGACY_WORKSPACE_ID,
          bindingType: "cloud",
          deviceId: null,
          environmentDefinitionId: null,
          locationRef: "legacy://git-checkpoint-workspace",
          locationFingerprint: null,
          bindingState: "active",
          lastVerifiedAt: null,
          versionNo: randomUUID(),
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
    workspaceBindingId: LEGACY_WORKSPACE_BINDING_ID,
  };
}

// ─── GitCheckpoint → V11FilesystemCheckpoint + V11ArtifactAttestation ─

const gitCheckpointTransformer: MigrationTransformer = async (record) => {
  const checkpointId = String(record.id ?? "");
  if (!checkpointId) {
    return { targets: [], anomalyReason: "GitCheckpoint.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "GitCheckpoint.threadId 为空" };
  }

  // 验证 threadId 存在（查询旧 Thread 表）
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  if (!threadRow) {
    return { targets: [], anomalyReason: `Thread ${threadId} 不存在` };
  }

  const tag = String(record.tag ?? "");
  const commitSha = String(record.commitSha ?? "");
  if (!commitSha) {
    return { targets: [], anomalyReason: "GitCheckpoint.commitSha 为空（无法构造制品 digest）" };
  }

  const createdAt = toDate(record.createdAt);
  // tag/commitSha→制品证明；filesChanged→changeListJson（存入 scanSummaryJson.changeList）
  const filesChanged = record.filesChanged != null ? String(record.filesChanged) : null;
  const artifactDigest = toContentHash(commitSha);

  // 确保 legacy workspace binding 存在（DB 级 FK 约束）
  const { targets: workspaceTargets, workspaceBindingId } = await ensureLegacyWorkspaceBinding();

  const targets = [
    ...workspaceTargets,
    {
      table: "V11FilesystemCheckpoint",
      data: {
        id: checkpointId,
        tenantId: DEFAULT_TENANT_ID,
        workspaceBindingId,
        // 旧 GitCheckpoint 无 Invocation 概念，用占位值（逻辑外键，无 DB FK 约束）
        invocationId: LEGACY_INVOCATION_ID,
        checkpointType: "git",
        checkpointRef: `git-tag:${tag}`,
        baseRevisionRef: commitSha,
        contentHash: artifactDigest,
        createdAt,
        expiresAt: null,
      },
    },
    {
      table: "V11ArtifactAttestation",
      data: {
        id: randomUUID(),
        tenantId: DEFAULT_TENANT_ID,
        artifactType: "runtime_revision",
        artifactRevisionId: checkpointId,
        artifactDigest,
        // 旧数据无签名/SBOM/provenance，用受管引用占位（不接受公网 URL）
        signatureBundleRef: `legacy://GitCheckpoint/${checkpointId}/signature`,
        sbomRef: `legacy://GitCheckpoint/${checkpointId}/sbom`,
        provenanceRef: `legacy://GitCheckpoint/${checkpointId}/provenance`,
        builderIdentity: "legacy-migration",
        // 旧 checkpoint 代表真实 git 状态，按 verified 迁移（枚举无 unknown）
        verificationState: "verified",
        policyRevisionId: null,
        sourceRevision: commitSha,
        buildPipeline: "git-checkpoint",
        dependencyLockFileHash: null,
        buildTime: createdAt,
        // filesChanged→changeListJson（scanSummaryJson 为唯一 JSON 字段）
        scanSummaryJson: filesChanged != null ? { changeList: filesChanged } : null,
        failureCode: null,
        verifiedAt: createdAt,
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
        createdAt,
      },
    },
  ];

  return { targets };
};

// ─── 导出 deployment_secret 域转换器注册表 ──────────────────

/** 创建 deployment_secret 域的全部转换器（key = 物理表名）。 */
export function createDeploymentTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["Deployment", deploymentTransformer],
    ["SecretMount", secretMountTransformer],
  ]);
}

// ─── 导出 git_checkpoint 域转换器注册表 ────────────────────

/** 创建 git_checkpoint 域的全部转换器（key = 物理表名）。 */
export function createGitCheckpointTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([["GitCheckpoint", gitCheckpointTransformer]]);
}
