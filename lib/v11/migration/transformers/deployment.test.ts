/**
 * S13-C03 deployment_secret 域 + git_checkpoint 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - Deployment 转换器：正常迁移、status→routeState 映射、threadId 不存在异常、cicdJobUrl 不迁移
 * - SecretMount 转换器：正常迁移、scopeRef 为空异常、status/rotatedAt→lifecycleState 映射、ciphertext 不迁移
 * - GitCheckpoint 转换器：正常迁移（含 legacy workspace binding 创建）、threadId 不存在异常、
 *   commitSha 为空异常、filesChanged→changeListJson、多 checkpoint 共享 workspace binding
 * - 端到端 deployment_secret 域 + git_checkpoint 域迁移
 * - 幂等性：二次运行跳过已迁移记录
 * - createDeploymentTransformers / createGitCheckpointTransformers 工厂
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  deployment as Deployment,
  gitCheckpoint as GitCheckpoint,
  secretMount as SecretMount,
  thread as Thread,
  user as User,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import {
  createDeploymentTransformers,
  createGitCheckpointTransformers,
} from "@/lib/v11/migration/transformers/deployment";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { v11ArtifactAttestation } from "@/lib/v11/schema/artifact";
import { v11DeploymentRoute, v11DeploymentRouteSet } from "@/lib/v11/schema/deployment-route";
import { v11FilesystemCheckpoint } from "@/lib/v11/schema/filesystem-checkpoint";
import { v11Grant } from "@/lib/v11/schema/permission";
import { v11CredentialRef } from "@/lib/v11/schema/tool";
import {
  workspace as V11Workspace,
  workspaceBinding as V11WorkspaceBinding,
} from "@/lib/v11/schema/workspace";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

/**
 * 插入 User + Thread（Deployment/GitCheckpoint 迁移只校验旧 Thread 存在，不需要 identity 域迁移）。
 */
async function setupThread(userId: string, threadId: string): Promise<void> {
  await db.insert(User).values({
    id: userId,
    externalId: `ext-${userId}`,
    email: `${userId}@example.com`,
    name: userId,
  });
  await db.insert(Thread).values({
    id: threadId,
    title: `测试会话 ${threadId}`,
    userId,
    status: "idle",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-02T00:00:00Z"),
  });
}

// ═══════════════════════════════════════════════════════════
// 1. Deployment 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 Deployment 转换器", () => {
  it("正常 Deployment 迁移为 V11DeploymentRouteSet + V11DeploymentRoute", async () => {
    const userId = "user-deploy-001";
    const threadId = "thread-deploy-001";
    await setupThread(userId, threadId);

    const createdAt = new Date("2024-06-01T00:00:00Z");
    const deployedAt = new Date("2024-06-01T01:00:00Z");
    await db.insert(Deployment).values({
      id: "deploy-001",
      threadId,
      environment: "prod",
      commitSha: "abc123def456",
      imageTag: "v1.0.0",
      artifactRef: "image://app:v1.0.0",
      cicdJobId: "job-001",
      cicdJobUrl: "https://ci.example.com/job/001",
      status: "deployed",
      deployedAt,
      createdAt,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("deployment_secret");

    const deployTable = result.tables.find((t) => t.sourceTable === "Deployment");
    expect(deployTable?.sourceCount).toBe(1);
    expect(deployTable?.targetCount).toBe(2); // V11DeploymentRouteSet + V11DeploymentRoute
    expect(deployTable?.anomalyCount).toBe(0);

    // 验证 V11DeploymentRouteSet 写入
    const [routeSet] = await db
      .select()
      .from(v11DeploymentRouteSet)
      .where(eq(v11DeploymentRouteSet.routeScopeKey, "prod:deploy-001"))
      .limit(1);
    expect(routeSet).toBeDefined();
    expect(routeSet?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(routeSet?.routeScopeJson).toEqual({
      environmentTag: "prod",
      threadId,
      artifactRef: "abc123def456",
    });
    expect(routeSet?.versionNo).toBe(1);

    // 验证 V11DeploymentRoute 写入（保留源 id）
    const [route] = await db
      .select()
      .from(v11DeploymentRoute)
      .where(eq(v11DeploymentRoute.id, "deploy-001"))
      .limit(1);
    expect(route).toBeDefined();
    expect(route?.routeSetId).toBe(routeSet?.id);
    expect(route?.trafficWeight).toBe(10000);
    expect(route?.routeState).toBe("enabled");
    expect(route?.effectiveFrom).toEqual(deployedAt);
  });

  it("status=deployed 映射为 routeState=enabled", async () => {
    const userId = "user-deploy-002";
    const threadId = "thread-deploy-002";
    await setupThread(userId, threadId);

    await db.insert(Deployment).values({
      id: "deploy-002",
      threadId,
      environment: "staging",
      commitSha: "sha-enabled",
      status: "deployed",
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("deployment_secret");

    const [route] = await db
      .select()
      .from(v11DeploymentRoute)
      .where(eq(v11DeploymentRoute.id, "deploy-002"))
      .limit(1);
    expect(route?.routeState).toBe("enabled");
  });

  it("status=pending/failed/rolled_back/deploying 映射为 routeState=disabled", async () => {
    const userId = "user-deploy-003";
    const threadId = "thread-deploy-003";
    await setupThread(userId, threadId);

    const statuses = ["pending", "deploying", "failed", "rolled_back"] as const;
    for (const [i, status] of statuses.entries()) {
      await db.insert(Deployment).values({
        id: `deploy-003-${i}`,
        threadId,
        environment: "prod",
        commitSha: `sha-${i}`,
        status,
        rolledBackAt: status === "rolled_back" ? new Date("2024-06-02T00:00:00Z") : null,
        createdAt: new Date("2024-06-01T00:00:00Z"),
      });
    }

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("deployment_secret");

    for (const [i] of statuses.entries()) {
      const [route] = await db
        .select()
        .from(v11DeploymentRoute)
        .where(eq(v11DeploymentRoute.id, `deploy-003-${i}`))
        .limit(1);
      expect(route?.routeState).toBe("disabled");
    }
  });

  it("threadId 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 Deployment，直接调用转换器验证防御逻辑
    const transformers = createDeploymentTransformers();
    const transformer = transformers.get("Deployment");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "deploy-orphan",
      threadId: "nonexistent-thread",
      environment: "prod",
      commitSha: "sha-orphan",
      status: "deployed",
      createdAt: "2024-06-01 00:00:00",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Thread nonexistent-thread 不存在");
  });

  it("threadId 为空时入异常队列", async () => {
    const transformers = createDeploymentTransformers();
    const transformer = transformers.get("Deployment");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "deploy-nothread",
      threadId: "",
      environment: "prod",
      status: "deployed",
      createdAt: "2024-06-01 00:00:00",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Deployment.threadId 为空");
  });

  it("cicdJobUrl 不迁移（routeScopeJson 不含 cicdJobUrl）", async () => {
    const userId = "user-deploy-004";
    const threadId = "thread-deploy-004";
    await setupThread(userId, threadId);

    await db.insert(Deployment).values({
      id: "deploy-004",
      threadId,
      environment: "prod",
      commitSha: "sha-cicd",
      cicdJobUrl: "https://ci.example.com/job/secret",
      status: "deployed",
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("deployment_secret");

    const [routeSet] = await db
      .select()
      .from(v11DeploymentRouteSet)
      .where(eq(v11DeploymentRouteSet.routeScopeKey, "prod:deploy-004"))
      .limit(1);
    expect(routeSet).toBeDefined();
    // routeScopeJson 只含 environmentTag/threadId/artifactRef，不含 cicdJobUrl
    expect(routeSet?.routeScopeJson).not.toHaveProperty("cicdJobUrl");
    const scopeJson = routeSet?.routeScopeJson as Record<string, unknown>;
    expect(scopeJson).toEqual({
      environmentTag: "prod",
      threadId,
      artifactRef: "sha-cicd",
    });
  });

  it("commitSha 为 null 时 artifactRef 为 null", async () => {
    const userId = "user-deploy-005";
    const threadId = "thread-deploy-005";
    await setupThread(userId, threadId);

    await db.insert(Deployment).values({
      id: "deploy-005",
      threadId,
      environment: "prod",
      // commitSha 不传，默认为 null
      status: "pending",
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("deployment_secret");

    const [routeSet] = await db
      .select()
      .from(v11DeploymentRouteSet)
      .where(eq(v11DeploymentRouteSet.routeScopeKey, "prod:deploy-005"))
      .limit(1);
    expect(routeSet).toBeDefined();
    const scopeJson = routeSet?.routeScopeJson as Record<string, unknown>;
    expect(scopeJson.artifactRef).toBeNull();
  });

  it("rolled_back 状态映射 effectiveUntil", async () => {
    const userId = "user-deploy-006";
    const threadId = "thread-deploy-006";
    await setupThread(userId, threadId);

    const rolledBackAt = new Date("2024-06-03T00:00:00Z");
    await db.insert(Deployment).values({
      id: "deploy-006",
      threadId,
      environment: "prod",
      commitSha: "sha-rollback",
      status: "rolled_back",
      deployedAt: new Date("2024-06-01T00:00:00Z"),
      rolledBackAt,
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("deployment_secret");

    const [route] = await db
      .select()
      .from(v11DeploymentRoute)
      .where(eq(v11DeploymentRoute.id, "deploy-006"))
      .limit(1);
    expect(route?.routeState).toBe("disabled");
    expect(route?.effectiveUntil).toEqual(rolledBackAt);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. SecretMount 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 SecretMount 转换器", () => {
  it("正常 SecretMount 迁移为 V11CredentialRef + V11Grant", async () => {
    const createdAt = new Date("2024-06-01T00:00:00Z");
    await db.insert(SecretMount).values({
      id: "secret-001",
      name: "API_KEY",
      scope: "thread",
      scopeRef: "thread-secret-001",
      keyId: "master-key-001",
      ciphertext: "base64-encoded-ciphertext",
      status: "active",
      createdAt,
      updatedAt: createdAt,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("deployment_secret");

    const secretTable = result.tables.find((t) => t.sourceTable === "SecretMount");
    expect(secretTable?.sourceCount).toBe(1);
    expect(secretTable?.targetCount).toBe(2); // V11CredentialRef + V11Grant
    expect(secretTable?.anomalyCount).toBe(0);

    // 验证 V11CredentialRef 写入（保留源 id）
    const [credRef] = await db
      .select()
      .from(v11CredentialRef)
      .where(eq(v11CredentialRef.id, "secret-001"))
      .limit(1);
    expect(credRef).toBeDefined();
    expect(credRef?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(credRef?.provider).toBe("vault");
    expect(credRef?.vaultRef).toContain("legacy-vault://SecretMount/secret-001");
    expect(credRef?.vaultRef).toContain("key=master-key-001");
    expect(credRef?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(credRef?.lifecycleState).toBe("active");
    expect(credRef?.scopeJson).toEqual(["thread:thread-secret-001"]);

    // 验证 V11Grant 写入
    const [grant] = await db
      .select()
      .from(v11Grant)
      .where(eq(v11Grant.credentialRefId, "secret-001"))
      .limit(1);
    expect(grant).toBeDefined();
    expect(grant?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(grant?.grantType).toBe("policy");
    expect(grant?.scopeJson).toEqual(["thread:thread-secret-001"]);
    expect(grant?.grantState).toBe("active");
    expect(grant?.issuedBy).toBe("legacy-migration");
  });

  it("scopeRef 为空时入异常队列", async () => {
    await db.insert(SecretMount).values({
      id: "secret-002",
      name: "API_KEY",
      scope: "thread",
      // scopeRef 不传，默认为 null
      keyId: "master-key-002",
      ciphertext: "base64-ciphertext",
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("deployment_secret");

    const secretTable = result.tables.find((t) => t.sourceTable === "SecretMount");
    expect(secretTable?.anomalyCount).toBe(1);
    expect(secretTable?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("SecretMount");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("scopeRef 为空");
  });

  it("status=revoked 映射为 lifecycleState=revoked 且 grantState=revoked", async () => {
    const updatedAt = new Date("2024-06-05T00:00:00Z");
    await db.insert(SecretMount).values({
      id: "secret-003",
      name: "DB_PASSWORD",
      scope: "project",
      scopeRef: "project-001",
      keyId: "master-key-003",
      ciphertext: "base64-revoked",
      status: "revoked",
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("deployment_secret");

    const [credRef] = await db
      .select()
      .from(v11CredentialRef)
      .where(eq(v11CredentialRef.id, "secret-003"))
      .limit(1);
    expect(credRef?.lifecycleState).toBe("revoked");

    const [grant] = await db
      .select()
      .from(v11Grant)
      .where(eq(v11Grant.credentialRefId, "secret-003"))
      .limit(1);
    expect(grant?.grantState).toBe("revoked");
    expect(grant?.revokedAt).toEqual(updatedAt);
  });

  it("rotatedAt 非空时映射为 lifecycleState=rotated", async () => {
    const rotatedAt = new Date("2024-06-10T00:00:00Z");
    await db.insert(SecretMount).values({
      id: "secret-004",
      name: "ROTATED_KEY",
      scope: "skill",
      scopeRef: "skill-001",
      keyId: "master-key-004",
      ciphertext: "base64-rotated",
      status: "active",
      rotatedAt,
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-06-10T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("deployment_secret");

    const [credRef] = await db
      .select()
      .from(v11CredentialRef)
      .where(eq(v11CredentialRef.id, "secret-004"))
      .limit(1);
    expect(credRef?.lifecycleState).toBe("rotated");
  });

  it("ciphertext 不迁移（vaultRef 不含密文，fingerprint 非 ciphertext）", async () => {
    const ciphertext = "super-secret-base64-ciphertext-value";
    await db.insert(SecretMount).values({
      id: "secret-005",
      name: "SECRET_VALUE",
      scope: "tool",
      scopeRef: "tool-001",
      keyId: "master-key-005",
      ciphertext,
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("deployment_secret");

    const [credRef] = await db
      .select()
      .from(v11CredentialRef)
      .where(eq(v11CredentialRef.id, "secret-005"))
      .limit(1);
    expect(credRef).toBeDefined();
    // vaultRef 是 legacy-vault 引用，不含密文
    expect(credRef?.vaultRef).not.toContain(ciphertext);
    expect(credRef?.vaultRef).toContain("legacy-vault://");
    // fingerprint 是 sha256: 前缀的源 id 摘要，不是密文
    expect(credRef?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(credRef?.fingerprint).not.toContain(ciphertext);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. GitCheckpoint 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 GitCheckpoint 转换器", () => {
  it("正常 GitCheckpoint 迁移为 V11FilesystemCheckpoint + V11ArtifactAttestation", async () => {
    const userId = "user-git-001";
    const threadId = "thread-git-001";
    await setupThread(userId, threadId);

    const createdAt = new Date("2024-06-01T00:00:00Z");
    await db.insert(GitCheckpoint).values({
      id: "git-cp-001",
      threadId,
      tag: "snow-checkpoint-abc123",
      commitSha: "def456abc789",
      reason: "before gitPush",
      filesChanged: "file1.ts\nfile2.ts",
      createdAt,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createGitCheckpointTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("git_checkpoint");

    const gitTable = result.tables.find((t) => t.sourceTable === "GitCheckpoint");
    expect(gitTable?.sourceCount).toBe(1);
    // targets = V11Workspace + V11WorkspaceBinding + V11FilesystemCheckpoint + V11ArtifactAttestation = 4
    expect(gitTable?.targetCount).toBe(4);
    expect(gitTable?.anomalyCount).toBe(0);

    // 验证 legacy V11Workspace 写入
    const [workspace] = await db
      .select()
      .from(V11Workspace)
      .where(eq(V11Workspace.id, "00000000-0000-4000-8000-0000000000d0"))
      .limit(1);
    expect(workspace).toBeDefined();
    expect(workspace?.workspaceKind).toBe("system");
    expect(workspace?.lifecycleState).toBe("active");

    // 验证 legacy V11WorkspaceBinding 写入
    const [binding] = await db
      .select()
      .from(V11WorkspaceBinding)
      .where(eq(V11WorkspaceBinding.id, "00000000-0000-4000-8000-0000000000d1"))
      .limit(1);
    expect(binding).toBeDefined();
    expect(binding?.bindingType).toBe("cloud");

    // 验证 V11FilesystemCheckpoint 写入（保留源 id）
    const [checkpoint] = await db
      .select()
      .from(v11FilesystemCheckpoint)
      .where(eq(v11FilesystemCheckpoint.id, "git-cp-001"))
      .limit(1);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(checkpoint?.workspaceBindingId).toBe("00000000-0000-4000-8000-0000000000d1");
    expect(checkpoint?.checkpointType).toBe("git");
    expect(checkpoint?.checkpointRef).toBe("git-tag:snow-checkpoint-abc123");
    expect(checkpoint?.baseRevisionRef).toBe("def456abc789");
    expect(checkpoint?.contentHash).toBe(`sha256:${createSha256Hex("def456abc789")}`);

    // 验证 V11ArtifactAttestation 写入
    const [attestation] = await db
      .select()
      .from(v11ArtifactAttestation)
      .where(eq(v11ArtifactAttestation.artifactRevisionId, "git-cp-001"))
      .limit(1);
    expect(attestation).toBeDefined();
    expect(attestation?.artifactType).toBe("runtime_revision");
    expect(attestation?.artifactDigest).toBe(`sha256:${createSha256Hex("def456abc789")}`);
    expect(attestation?.sourceRevision).toBe("def456abc789");
    expect(attestation?.verificationState).toBe("verified");
    expect(attestation?.buildPipeline).toBe("git-checkpoint");
    expect(attestation?.scanSummaryJson).toEqual({ changeList: "file1.ts\nfile2.ts" });
  });

  it("threadId 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 GitCheckpoint，直接调用转换器验证防御逻辑
    const transformers = createGitCheckpointTransformers();
    const transformer = transformers.get("GitCheckpoint");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "git-cp-orphan",
      threadId: "nonexistent-thread",
      tag: "snow-checkpoint-orphan",
      commitSha: "sha-orphan",
      reason: "test",
      createdAt: "2024-06-01 00:00:00",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Thread nonexistent-thread 不存在");
  });

  it("threadId 为空时入异常队列", async () => {
    const transformers = createGitCheckpointTransformers();
    const transformer = transformers.get("GitCheckpoint");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "git-cp-nothread",
      threadId: "",
      tag: "snow-checkpoint-nothread",
      commitSha: "sha-nothread",
      reason: "test",
      createdAt: "2024-06-01 00:00:00",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("GitCheckpoint.threadId 为空");
  });

  it("commitSha 为空时入异常队列", async () => {
    // 需要先创建真实 Thread，否则 threadId 存在性检查会先触发异常
    const userId = "user-git-nosha";
    const threadId = "thread-git-nosha";
    await setupThread(userId, threadId);

    const transformers = createGitCheckpointTransformers();
    const transformer = transformers.get("GitCheckpoint");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "git-cp-nosha",
      threadId,
      tag: "snow-checkpoint-nosha",
      commitSha: "",
      reason: "test",
      createdAt: "2024-06-01 00:00:00",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("GitCheckpoint.commitSha 为空");
  });

  it("filesChanged 为 null 时 scanSummaryJson 为 null", async () => {
    const userId = "user-git-002";
    const threadId = "thread-git-002";
    await setupThread(userId, threadId);

    await db.insert(GitCheckpoint).values({
      id: "git-cp-002",
      threadId,
      tag: "snow-checkpoint-no-files",
      commitSha: "sha-no-files",
      reason: "empty checkpoint",
      // filesChanged 不传，默认为 null
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createGitCheckpointTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("git_checkpoint");

    const [attestation] = await db
      .select()
      .from(v11ArtifactAttestation)
      .where(eq(v11ArtifactAttestation.artifactRevisionId, "git-cp-002"))
      .limit(1);
    expect(attestation?.scanSummaryJson).toBeNull();
  });

  it("多个 GitCheckpoint 共享 legacy workspace binding（不重复创建）", async () => {
    const userId = "user-git-003";
    const threadId = "thread-git-003";
    await setupThread(userId, threadId);

    await db.insert(GitCheckpoint).values({
      id: "git-cp-003a",
      threadId,
      tag: "snow-checkpoint-a",
      commitSha: "sha-a",
      reason: "checkpoint a",
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });
    await db.insert(GitCheckpoint).values({
      id: "git-cp-003b",
      threadId,
      tag: "snow-checkpoint-b",
      commitSha: "sha-b",
      reason: "checkpoint b",
      createdAt: new Date("2024-06-01T01:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createGitCheckpointTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("git_checkpoint");

    // 2 个 checkpoint，每个产出 V11FilesystemCheckpoint + V11ArtifactAttestation = 4
    // 首个 checkpoint 额外产出 V11Workspace + V11WorkspaceBinding = 2
    // 总 targetCount = 4 + 2 = 6
    expect(result.totalTargetCount).toBe(6);

    // legacy workspace 只创建一次
    const workspaces = await db
      .select()
      .from(V11Workspace)
      .where(eq(V11Workspace.id, "00000000-0000-4000-8000-0000000000d0"));
    expect(workspaces.length).toBe(1);

    const bindings = await db
      .select()
      .from(V11WorkspaceBinding)
      .where(eq(V11WorkspaceBinding.id, "00000000-0000-4000-8000-0000000000d1"));
    expect(bindings.length).toBe(1);

    // 2 个 V11FilesystemCheckpoint
    const checkpoints = await db.select().from(v11FilesystemCheckpoint);
    expect(checkpoints.length).toBe(2);

    // 2 个 V11ArtifactAttestation
    const attestations = await db.select().from(v11ArtifactAttestation);
    expect(attestations.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 端到端 deployment_secret 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 deployment_secret 域端到端迁移", () => {
  it("完整 deployment_secret 域迁移：Deployment + SecretMount 顺序执行", async () => {
    const userId = "user-e2e-deploy-001";
    const threadId = "thread-e2e-deploy-001";
    await setupThread(userId, threadId);

    // 插入 Deployment
    await db.insert(Deployment).values({
      id: "deploy-e2e-001",
      threadId,
      environment: "prod",
      commitSha: "sha-e2e-deploy",
      status: "deployed",
      deployedAt: new Date("2024-06-01T01:00:00Z"),
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    // 插入 SecretMount
    await db.insert(SecretMount).values({
      id: "secret-e2e-001",
      name: "API_KEY",
      scope: "thread",
      scopeRef: threadId,
      keyId: "master-e2e",
      ciphertext: "base64-e2e",
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createDeploymentTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("deployment_secret");

    // 汇总验证
    expect(result.totalSourceCount).toBe(2); // 1 Deployment + 1 SecretMount
    expect(result.totalAnomalyCount).toBe(0);

    // Deployment: 2 目标（RouteSet + Route）
    const deployTable = result.tables.find((t) => t.sourceTable === "Deployment");
    expect(deployTable?.targetCount).toBe(2);

    // SecretMount: 2 目标（CredentialRef + Grant）
    const secretTable = result.tables.find((t) => t.sourceTable === "SecretMount");
    expect(secretTable?.targetCount).toBe(2);

    // 验证 V11 表实际写入
    const routes = await db.select().from(v11DeploymentRoute);
    expect(routes.length).toBe(1);

    const routeSets = await db.select().from(v11DeploymentRouteSet);
    expect(routeSets.length).toBe(1);

    const credRefs = await db.select().from(v11CredentialRef);
    expect(credRefs.length).toBe(1);

    const grants = await db.select().from(v11Grant);
    expect(grants.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 端到端 git_checkpoint 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 git_checkpoint 域端到端迁移", () => {
  it("完整 git_checkpoint 域迁移：GitCheckpoint 执行", async () => {
    const userId = "user-e2e-git-001";
    const threadId = "thread-e2e-git-001";
    await setupThread(userId, threadId);

    await db.insert(GitCheckpoint).values({
      id: "git-e2e-001",
      threadId,
      tag: "snow-checkpoint-e2e",
      commitSha: "sha-e2e-git",
      reason: "e2e test",
      filesChanged: "a.ts\nb.ts\nc.ts",
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createGitCheckpointTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("git_checkpoint");

    expect(result.totalSourceCount).toBe(1);
    expect(result.totalAnomalyCount).toBe(0);
    // 1 GitCheckpoint → V11Workspace + V11WorkspaceBinding + V11FilesystemCheckpoint + V11ArtifactAttestation = 4
    expect(result.totalTargetCount).toBe(4);

    // 验证 V11 表实际写入
    const checkpoints = await db.select().from(v11FilesystemCheckpoint);
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0]?.id).toBe("git-e2e-001");

    const attestations = await db.select().from(v11ArtifactAttestation);
    expect(attestations.length).toBe(1);
    expect(attestations[0]?.sourceRevision).toBe("sha-e2e-git");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 幂等性
// ═══════════════════════════════════════════════════════════

describe("S13-C03 幂等性", () => {
  it("deployment_secret 域二次运行跳过所有已迁移记录", async () => {
    const userId = "user-idem-deploy-001";
    const threadId = "thread-idem-deploy-001";
    await setupThread(userId, threadId);

    await db.insert(Deployment).values({
      id: "deploy-idem-001",
      threadId,
      environment: "prod",
      commitSha: "sha-idem",
      status: "deployed",
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });
    await db.insert(SecretMount).values({
      id: "secret-idem-001",
      name: "API_KEY",
      scope: "thread",
      scopeRef: threadId,
      keyId: "master-idem",
      ciphertext: "base64-idem",
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createDeploymentTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("deployment_secret");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    // 记录第一次的 V11 表行数
    const routeCount1 = (await db.select().from(v11DeploymentRoute)).length;
    const credRefCount1 = (await db.select().from(v11CredentialRef)).length;

    // 第二次运行：应全部跳过，不产生新目标
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("deployment_secret");

    expect(result2.totalTargetCount).toBe(0);
    expect(result2.totalSkipCount).toBe(2); // 2 条源记录全部跳过

    // V11 表行数不变
    const routeCount2 = (await db.select().from(v11DeploymentRoute)).length;
    const credRefCount2 = (await db.select().from(v11CredentialRef)).length;
    expect(routeCount2).toBe(routeCount1);
    expect(credRefCount2).toBe(credRefCount1);
  });

  it("git_checkpoint 域二次运行跳过所有已迁移记录", async () => {
    const userId = "user-idem-git-001";
    const threadId = "thread-idem-git-001";
    await setupThread(userId, threadId);

    await db.insert(GitCheckpoint).values({
      id: "git-idem-001",
      threadId,
      tag: "snow-checkpoint-idem",
      commitSha: "sha-idem-git",
      reason: "idempotency test",
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createGitCheckpointTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("git_checkpoint");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    // 记录第一次的 V11 表行数
    const checkpointCount1 = (await db.select().from(v11FilesystemCheckpoint)).length;
    const attestationCount1 = (await db.select().from(v11ArtifactAttestation)).length;

    // 第二次运行：应全部跳过，不产生新目标
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("git_checkpoint");

    expect(result2.totalTargetCount).toBe(0);
    expect(result2.totalSkipCount).toBe(1); // 1 条源记录跳过

    // V11 表行数不变
    const checkpointCount2 = (await db.select().from(v11FilesystemCheckpoint)).length;
    const attestationCount2 = (await db.select().from(v11ArtifactAttestation)).length;
    expect(checkpointCount2).toBe(checkpointCount1);
    expect(attestationCount2).toBe(attestationCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. 工厂函数
// ═══════════════════════════════════════════════════════════

describe("S13-C03 工厂函数", () => {
  it("createDeploymentTransformers 返回 2 个转换器", () => {
    const transformers = createDeploymentTransformers();
    expect(transformers.size).toBe(2);
    expect(transformers.has("Deployment")).toBe(true);
    expect(transformers.has("SecretMount")).toBe(true);
  });

  it("createGitCheckpointTransformers 返回 1 个转换器", () => {
    const transformers = createGitCheckpointTransformers();
    expect(transformers.size).toBe(1);
    expect(transformers.has("GitCheckpoint")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const deployTransformers = createDeploymentTransformers();
    for (const [, transformer] of deployTransformers) {
      expect(typeof transformer).toBe("function");
    }
    const gitTransformers = createGitCheckpointTransformers();
    for (const [, transformer] of gitTransformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createDeploymentTransformers();
    const t2 = createDeploymentTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);

    const g1 = createGitCheckpointTransformers();
    const g2 = createGitCheckpointTransformers();
    expect(g1).not.toBe(g2);
    expect(g1.size).toBe(g2.size);
  });
});

// ─── 测试辅助 ──────────────────────────────────────────────

/** 计算 sha256 hex 摘要（与 deployment.ts 中 sha256Hex 逻辑对齐）。 */
function createSha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
