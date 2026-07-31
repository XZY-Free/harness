/**
 * V11 Artifact + FileChange + FilesystemCheckpoint 集成测试（阶段 8 S08-C06）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §7.3-7.4、§5.4、§6.3、§9 不变量第 11 条。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §5.3。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W06。
 *
 * 覆盖：
 * - 辅助函数：isRuntimeArtifactType / isVisibilityScope / isFileChangeType /
 *   isFilesystemCheckpointType / isValidPathRef / isValidManagedRef / computeFileHash /
 *   validateFileChangeHashes（create/update/delete/rename/move 互斥）。
 * - createArtifact：成功 + 默认值 + itemId UNIQUE 冲突 + 会话/Job 互斥 + 校验错误。
 * - Artifact 查询：byId / byItemId / byInvocation / byThread / byJob + 跨租户隔离。
 * - createFileChanges：批量 + 自动 pathRef 校验 + hash 互斥 + 校验错误。
 * - FileChange 查询：byId / byToolCall / byWorkspaceBinding / byArtifact + 跨租户隔离。
 * - linkFileChangeToArtifact：成功 + 重复关联拒绝 + 跨租户。
 * - createFilesystemCheckpoint：成功 + 校验错误 + 跨租户。
 * - FilesystemCheckpoint 查询：byId / byInvocation / byWorkspaceBinding / getLatest + 跨租户隔离。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  ArtifactItemConflictError,
  ArtifactNotFoundError,
  ArtifactValidationError,
  FileChangeNotFoundError,
  FileChangeValidationError,
  FilesystemCheckpointNotFoundError,
  FilesystemCheckpointValidationError,
  computeFileHash,
  createArtifact,
  createFileChanges,
  createFilesystemCheckpoint,
  getArtifactById,
  getArtifactByItemId,
  getFileChangeById,
  getFilesystemCheckpointById,
  getLatestFilesystemCheckpoint,
  isFileChangeType,
  isFilesystemCheckpointType,
  isRuntimeArtifactType,
  isValidManagedRef,
  isValidPathRef,
  isVisibilityScope,
  linkFileChangeToArtifact,
  listArtifactsByInvocation,
  listArtifactsByJob,
  listArtifactsByThread,
  listFileChangesByArtifact,
  listFileChangesByToolCall,
  listFileChangesByWorkspaceBinding,
  listFilesystemCheckpointsByInvocation,
  listFilesystemCheckpointsByWorkspaceBinding,
  validateFileChangeHashes,
} from "@/lib/v11/capability/artifact-queries";
import { type V11ToolCall, createToolCall } from "@/lib/v11/capability/tool-call-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import type { V11WorkspaceBinding } from "@/lib/v11/schema/workspace";
import { createWorkspace, createWorkspaceBinding } from "@/lib/v11/workspace/workspace-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 默认租户 + Workspace + Binding + ToolCall ──

async function seedTenant() {
  const tenant = await ensureDefaultTenant();
  return tenant.id;
}

async function seedWorkspaceAndBinding(
  tenantId: string,
  bindingType: "cloud" | "desktop" = "cloud",
): Promise<{ workspaceId: string; binding: V11WorkspaceBinding }> {
  const workspace = await createWorkspace({
    tenantId,
    workspaceKey: `ws-${randomUUID()}`,
    displayName: "Test Workspace",
  });
  const binding = await createWorkspaceBinding({
    tenantId,
    workspaceId: workspace.id,
    bindingType,
    locationRef: `s3://test-bucket/${randomUUID()}`,
  });
  return { workspaceId: workspace.id, binding };
}

async function seedToolCall(tenantId: string): Promise<V11ToolCall> {
  return createToolCall({
    tenantId,
    invocationId: randomUUID(),
    toolId: randomUUID(),
    toolSchemaRevisionId: randomUUID(),
    schemaHash: "sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
    operationId: `op-${randomUUID()}`,
    argumentsRedactedJson: { target: "test" },
  });
}

/** 构造一个合法的 sha256: hash（用于 contentHash / beforeHash / afterHash）。 */
function buildValidHash(seed: string): string {
  return computeFileHash(seed);
}

/** 构造合法 createArtifact 入参（最小必填集）。 */
function buildArtifactInput(
  tenantId: string,
  invocationId: string,
  overrides?: Partial<{
    contentHash: string;
    contentRef: string;
    itemId: string | null;
    threadId: string | null;
    turnId: string | null;
    jobId: string | null;
    artifactType: "file" | "image" | "archive" | "report" | "dataset" | "log";
    visibilityScope: "thread" | "workspace" | "owner" | "organization";
    displayName: string;
    mediaType: string;
    byteSize: number;
  }>,
) {
  return {
    tenantId,
    invocationId,
    threadId: overrides?.threadId ?? null,
    turnId: overrides?.turnId ?? null,
    jobId: overrides?.jobId ?? null,
    itemId: overrides?.itemId ?? null,
    artifactType: overrides?.artifactType ?? ("file" as const),
    displayName: overrides?.displayName ?? "test-report.xlsx",
    contentRef: overrides?.contentRef ?? `s3://test-bucket/${randomUUID()}`,
    mediaType:
      overrides?.mediaType ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    byteSize: overrides?.byteSize ?? 1024,
    contentHash: overrides?.contentHash ?? buildValidHash(`content-${randomUUID()}`),
    visibilityScope: overrides?.visibilityScope ?? ("workspace" as const),
  };
}

// ═══════════════════════════════════════════════════════════
// 1. 辅助函数校验
// ═══════════════════════════════════════════════════════════

describe("V11 artifact-queries：辅助函数校验", () => {
  it("isRuntimeArtifactType：合法/非法判断", () => {
    expect(isRuntimeArtifactType("file")).toBe(true);
    expect(isRuntimeArtifactType("image")).toBe(true);
    expect(isRuntimeArtifactType("archive")).toBe(true);
    expect(isRuntimeArtifactType("report")).toBe(true);
    expect(isRuntimeArtifactType("dataset")).toBe(true);
    expect(isRuntimeArtifactType("log")).toBe(true);
    expect(isRuntimeArtifactType("agent_revision")).toBe(false); // ArtifactAttestation 类型
    expect(isRuntimeArtifactType("")).toBe(false);
  });

  it("isVisibilityScope：合法/非法判断", () => {
    expect(isVisibilityScope("thread")).toBe(true);
    expect(isVisibilityScope("workspace")).toBe(true);
    expect(isVisibilityScope("owner")).toBe(true);
    expect(isVisibilityScope("organization")).toBe(true);
    expect(isVisibilityScope("public")).toBe(false);
  });

  it("isFileChangeType：合法/非法判断", () => {
    expect(isFileChangeType("create")).toBe(true);
    expect(isFileChangeType("update")).toBe(true);
    expect(isFileChangeType("delete")).toBe(true);
    expect(isFileChangeType("rename")).toBe(true);
    expect(isFileChangeType("move")).toBe(true);
    expect(isFileChangeType("copy")).toBe(false);
  });

  it("isFilesystemCheckpointType：合法/非法判断", () => {
    expect(isFilesystemCheckpointType("git")).toBe(true);
    expect(isFilesystemCheckpointType("snapshot")).toBe(true);
    expect(isFilesystemCheckpointType("tarball")).toBe(true);
    expect(isFilesystemCheckpointType("zip")).toBe(true);
    expect(isFilesystemCheckpointType("diff")).toBe(false);
  });

  it("isValidPathRef：拒绝绝对路径", () => {
    expect(isValidPathRef("a/b/c.xlsx")).toBe(true);
    expect(isValidPathRef("report.xlsx")).toBe(true);
    expect(isValidPathRef("docs/report.pdf")).toBe(true);
    // 拒绝 Unix 绝对路径
    expect(isValidPathRef("/abs/path")).toBe(false);
    // 拒绝 Windows 绝对路径
    expect(isValidPathRef("C:\\Windows\\path")).toBe(false);
    expect(isValidPathRef("D:/data/file.txt")).toBe(false);
    // 拒绝 UNC 路径
    expect(isValidPathRef("\\\\share\\path")).toBe(false);
    // 拒绝空字符串
    expect(isValidPathRef("")).toBe(false);
  });

  it("isValidManagedRef：拒绝公网 URL", () => {
    expect(isValidManagedRef("s3://bucket/key")).toBe(true);
    expect(isValidManagedRef("oci://registry/path")).toBe(true);
    expect(isValidManagedRef("gs://bucket/key")).toBe(true);
    expect(isValidManagedRef("file://internal/path")).toBe(true);
    // 拒绝公网 URL
    expect(isValidManagedRef("http://example.com/file")).toBe(false);
    expect(isValidManagedRef("https://example.com/file")).toBe(false);
    expect(isValidManagedRef("")).toBe(false);
  });

  it("computeFileHash：返回 sha256: 前缀 + 64 hex", () => {
    const hash = computeFileHash("test content");
    expect(hash.startsWith("sha256:")).toBe(true);
    expect(hash.slice("sha256:".length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computeFileHash：相同输入产生相同 hash", () => {
    expect(computeFileHash("abc")).toBe(computeFileHash("abc"));
  });

  it("computeFileHash：不同输入产生不同 hash", () => {
    expect(computeFileHash("abc")).not.toBe(computeFileHash("abd"));
  });

  it("validateFileChangeHashes：create 时 beforeHash=null + afterHash 必填", () => {
    const hash = buildValidHash("after");
    // 合法
    expect(() => validateFileChangeHashes("create", null, hash)).not.toThrow();
    // beforeHash 非空 → 抛错
    expect(() => validateFileChangeHashes("create", hash, hash)).toThrow(FileChangeValidationError);
    // afterHash 为 null → 抛错
    expect(() => validateFileChangeHashes("create", null, null)).toThrow(FileChangeValidationError);
  });

  it("validateFileChangeHashes：delete 时 beforeHash 必填 + afterHash=null", () => {
    const hash = buildValidHash("before");
    // 合法
    expect(() => validateFileChangeHashes("delete", hash, null)).not.toThrow();
    // afterHash 非空 → 抛错
    expect(() => validateFileChangeHashes("delete", hash, hash)).toThrow(FileChangeValidationError);
    // beforeHash 为 null → 抛错
    expect(() => validateFileChangeHashes("delete", null, null)).toThrow(FileChangeValidationError);
  });

  it("validateFileChangeHashes：update/rename/move 时 beforeHash 与 afterHash 都必填", () => {
    const before = buildValidHash("before");
    const after = buildValidHash("after");
    // 合法
    expect(() => validateFileChangeHashes("update", before, after)).not.toThrow();
    expect(() => validateFileChangeHashes("rename", before, after)).not.toThrow();
    expect(() => validateFileChangeHashes("move", before, after)).not.toThrow();
    // beforeHash 为 null → 抛错
    expect(() => validateFileChangeHashes("update", null, after)).toThrow(
      FileChangeValidationError,
    );
    // afterHash 为 null → 抛错
    expect(() => validateFileChangeHashes("update", before, null)).toThrow(
      FileChangeValidationError,
    );
  });

  it("validateFileChangeHashes：hash 格式非法 → 抛错", () => {
    expect(() => validateFileChangeHashes("update", "not-a-hash", buildValidHash("after"))).toThrow(
      FileChangeValidationError,
    );
    expect(() => validateFileChangeHashes("update", buildValidHash("before"), "md5:abc")).toThrow(
      FileChangeValidationError,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 2. createArtifact：成功 + UNIQUE + 互斥 + 校验
// ═══════════════════════════════════════════════════════════

describe("V11 createArtifact：成功 + UNIQUE + 互斥 + 校验", () => {
  it("成功创建 + 默认值填充 + createdAt 自动设置", async () => {
    const tenantId = await seedTenant();
    const invocationId = randomUUID();

    const artifact = await createArtifact(buildArtifactInput(tenantId, invocationId));

    expect(artifact.tenantId).toBe(tenantId);
    expect(artifact.invocationId).toBe(invocationId);
    expect(artifact.threadId).toBeNull();
    expect(artifact.turnId).toBeNull();
    expect(artifact.jobId).toBeNull();
    expect(artifact.itemId).toBeNull();
    expect(artifact.artifactType).toBe("file");
    expect(artifact.displayName).toBe("test-report.xlsx");
    expect(artifact.visibilityScope).toBe("workspace");
    expect(artifact.byteSize).toBe(1024);
    expect(artifact.expiresAt).toBeNull();
    expect(artifact.createdAt).toBeInstanceOf(Date);
  });

  it("会话产物：threadId + turnId 填写 + visibilityScope=thread", async () => {
    const tenantId = await seedTenant();
    const invocationId = randomUUID();
    const threadId = randomUUID();
    const turnId = randomUUID();

    const artifact = await createArtifact(
      buildArtifactInput(tenantId, invocationId, {
        threadId,
        turnId,
        visibilityScope: "thread",
      }),
    );

    expect(artifact.threadId).toBe(threadId);
    expect(artifact.turnId).toBe(turnId);
    expect(artifact.jobId).toBeNull();
    expect(artifact.visibilityScope).toBe("thread");
  });

  it("Job 产物：jobId 填写 + threadId/turnId 为 null", async () => {
    const tenantId = await seedTenant();
    const invocationId = randomUUID();
    const jobId = randomUUID();

    const artifact = await createArtifact(buildArtifactInput(tenantId, invocationId, { jobId }));

    expect(artifact.jobId).toBe(jobId);
    expect(artifact.threadId).toBeNull();
    expect(artifact.turnId).toBeNull();
  });

  it("会话产物与 Job 产物互斥：同时填写 threadId + jobId → ValidationError", async () => {
    const tenantId = await seedTenant();
    const invocationId = randomUUID();

    await expect(
      createArtifact(
        buildArtifactInput(tenantId, invocationId, {
          threadId: randomUUID(),
          jobId: randomUUID(),
        }),
      ),
    ).rejects.toThrow(ArtifactValidationError);
  });

  it("itemId UNIQUE 冲突：同 itemId 二次创建 → ArtifactItemConflictError", async () => {
    const tenantId = await seedTenant();
    const invocationId = randomUUID();
    const itemId = randomUUID();

    await createArtifact(buildArtifactInput(tenantId, invocationId, { itemId }));

    await expect(
      createArtifact(buildArtifactInput(tenantId, randomUUID(), { itemId })),
    ).rejects.toThrow(ArtifactItemConflictError);
  });

  it("空 tenantId / invocationId → ValidationError", async () => {
    await expect(createArtifact(buildArtifactInput("", randomUUID()))).rejects.toThrow(
      ArtifactValidationError,
    );

    const tenantId = await seedTenant();
    await expect(createArtifact(buildArtifactInput(tenantId, ""))).rejects.toThrow(
      ArtifactValidationError,
    );
  });

  it("非法 contentHash 格式 → ValidationError", async () => {
    const tenantId = await seedTenant();
    await expect(
      createArtifact(buildArtifactInput(tenantId, randomUUID(), { contentHash: "md5:abc" })),
    ).rejects.toThrow(ArtifactValidationError);
  });

  it("contentRef 为公网 URL → ValidationError", async () => {
    const tenantId = await seedTenant();
    await expect(
      createArtifact(
        buildArtifactInput(tenantId, randomUUID(), {
          contentRef: "https://example.com/file.xlsx",
        }),
      ),
    ).rejects.toThrow(ArtifactValidationError);
  });

  it("非法 artifactType → ValidationError", async () => {
    const tenantId = await seedTenant();
    await expect(
      createArtifact(
        buildArtifactInput(tenantId, randomUUID(), {
          artifactType: "agent_revision" as never,
        }),
      ),
    ).rejects.toThrow(ArtifactValidationError);
  });

  it("非法 visibilityScope → ValidationError", async () => {
    const tenantId = await seedTenant();
    await expect(
      createArtifact(
        buildArtifactInput(tenantId, randomUUID(), {
          visibilityScope: "public" as never,
        }),
      ),
    ).rejects.toThrow(ArtifactValidationError);
  });

  it("byteSize 为负数 → ValidationError", async () => {
    const tenantId = await seedTenant();
    await expect(
      createArtifact(buildArtifactInput(tenantId, randomUUID(), { byteSize: -1 })),
    ).rejects.toThrow(ArtifactValidationError);
  });

  it("displayName 超过 256 字符 → ValidationError", async () => {
    const tenantId = await seedTenant();
    await expect(
      createArtifact(
        buildArtifactInput(tenantId, randomUUID(), {
          displayName: "x".repeat(257),
        }),
      ),
    ).rejects.toThrow(ArtifactValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Artifact 查询 + 跨租户隔离
// ═══════════════════════════════════════════════════════════

describe("V11 Artifact 查询 + 跨租户隔离", () => {
  it("getArtifactById：跨租户返回 null", async () => {
    const tenantId = await seedTenant();
    const artifact = await createArtifact(buildArtifactInput(tenantId, randomUUID()));

    const found = await getArtifactById(tenantId, artifact.id);
    expect(found?.id).toBe(artifact.id);

    const other = await getArtifactById(randomUUID(), artifact.id);
    expect(other).toBeNull();
  });

  it("getArtifactByItemId：一对一反向查询 + 跨租户", async () => {
    const tenantId = await seedTenant();
    const itemId = randomUUID();
    const artifact = await createArtifact(buildArtifactInput(tenantId, randomUUID(), { itemId }));

    const found = await getArtifactByItemId(tenantId, itemId);
    expect(found?.id).toBe(artifact.id);

    const other = await getArtifactByItemId(randomUUID(), itemId);
    expect(other).toBeNull();
  });

  it("listArtifactsByInvocation：按 createdAt 升序 + 跨租户返回空", async () => {
    const tenantId = await seedTenant();
    const invocationId = randomUUID();
    const a1 = await createArtifact(buildArtifactInput(tenantId, invocationId));
    const a2 = await createArtifact(buildArtifactInput(tenantId, invocationId));

    const list = await listArtifactsByInvocation(tenantId, invocationId);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(a1.id);
    expect(list[1]?.id).toBe(a2.id);

    const other = await listArtifactsByInvocation(randomUUID(), invocationId);
    expect(other).toEqual([]);
  });

  it("listArtifactsByThread：按 threadId 过滤", async () => {
    const tenantId = await seedTenant();
    const threadId = randomUUID();
    await createArtifact(
      buildArtifactInput(tenantId, randomUUID(), { threadId, visibilityScope: "thread" }),
    );
    await createArtifact(
      buildArtifactInput(tenantId, randomUUID(), { threadId, visibilityScope: "thread" }),
    );
    // 不同 threadId
    await createArtifact(
      buildArtifactInput(tenantId, randomUUID(), {
        threadId: randomUUID(),
        visibilityScope: "thread",
      }),
    );

    const list = await listArtifactsByThread(tenantId, threadId);
    expect(list).toHaveLength(2);
    expect(list.every((a) => a.threadId === threadId)).toBe(true);
  });

  it("listArtifactsByJob：按 jobId 过滤", async () => {
    const tenantId = await seedTenant();
    const jobId = randomUUID();
    await createArtifact(buildArtifactInput(tenantId, randomUUID(), { jobId }));

    const list = await listArtifactsByJob(tenantId, jobId);
    expect(list).toHaveLength(1);
    expect(list[0]?.jobId).toBe(jobId);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. createFileChanges：批量 + 校验
// ═══════════════════════════════════════════════════════════

describe("V11 createFileChanges：批量 + 校验", () => {
  it("批量创建 + 自动 hash 校验通过", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const beforeHash = buildValidHash("before");
    const afterHash = buildValidHash("after");

    const changes = await createFileChanges({
      tenantId,
      toolCallId: toolCall.id,
      workspaceBindingId: binding.id,
      changes: [
        { pathRef: "docs/report.xlsx", changeType: "create", afterHash },
        { pathRef: "data/config.json", changeType: "update", beforeHash, afterHash },
        { pathRef: "temp/old.log", changeType: "delete", beforeHash },
      ],
    });

    expect(changes).toHaveLength(3);
    // 同事务批量插入时 createdAt 几乎相同，最终按 id 升序排序不稳定，
    // 改用 Map by pathRef 进行断言（与 S08-C05 listEffectTargets 同样模式）。
    const byPath = new Map(changes.map((c) => [c.pathRef, c]));
    expect(byPath.get("docs/report.xlsx")?.changeType).toBe("create");
    expect(byPath.get("docs/report.xlsx")?.afterHash).toBe(afterHash);
    expect(byPath.get("docs/report.xlsx")?.beforeHash).toBeNull();
    expect(byPath.get("data/config.json")?.changeType).toBe("update");
    expect(byPath.get("data/config.json")?.beforeHash).toBe(beforeHash);
    expect(byPath.get("data/config.json")?.afterHash).toBe(afterHash);
    expect(byPath.get("temp/old.log")?.changeType).toBe("delete");
    expect(byPath.get("temp/old.log")?.beforeHash).toBe(beforeHash);
    expect(byPath.get("temp/old.log")?.afterHash).toBeNull();
  });

  it("空 changes 数组 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);

    await expect(
      createFileChanges({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        changes: [],
      }),
    ).rejects.toThrow(FileChangeValidationError);
  });

  it("绝对路径 pathRef → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    await expect(
      createFileChanges({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        changes: [{ pathRef: "/abs/path/file.txt", changeType: "create", afterHash }],
      }),
    ).rejects.toThrow(FileChangeValidationError);
  });

  it("Windows 绝对路径 pathRef → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    await expect(
      createFileChanges({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        changes: [{ pathRef: "C:\\Windows\\file.txt", changeType: "create", afterHash }],
      }),
    ).rejects.toThrow(FileChangeValidationError);
  });

  it("changeType=create 但 beforeHash 非空 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const beforeHash = buildValidHash("before");
    const afterHash = buildValidHash("after");

    await expect(
      createFileChanges({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        changes: [{ pathRef: "a.txt", changeType: "create", beforeHash, afterHash }],
      }),
    ).rejects.toThrow(FileChangeValidationError);
  });

  it("changeType=delete 但 afterHash 非空 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const beforeHash = buildValidHash("before");
    const afterHash = buildValidHash("after");

    await expect(
      createFileChanges({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        changes: [{ pathRef: "a.txt", changeType: "delete", beforeHash, afterHash }],
      }),
    ).rejects.toThrow(FileChangeValidationError);
  });

  it("changeType=update 但 beforeHash 为 null → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    await expect(
      createFileChanges({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        changes: [{ pathRef: "a.txt", changeType: "update", afterHash }],
      }),
    ).rejects.toThrow(FileChangeValidationError);
  });

  it("非法 hash 格式 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);

    await expect(
      createFileChanges({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        changes: [{ pathRef: "a.txt", changeType: "create", afterHash: "not-a-hash" }],
      }),
    ).rejects.toThrow(FileChangeValidationError);
  });

  it("空 tenantId / toolCallId / workspaceBindingId → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    await expect(
      createFileChanges({
        tenantId: "",
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        changes: [{ pathRef: "a.txt", changeType: "create", afterHash }],
      }),
    ).rejects.toThrow(FileChangeValidationError);

    await expect(
      createFileChanges({
        tenantId,
        toolCallId: "",
        workspaceBindingId: binding.id,
        changes: [{ pathRef: "a.txt", changeType: "create", afterHash }],
      }),
    ).rejects.toThrow(FileChangeValidationError);

    await expect(
      createFileChanges({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: "",
        changes: [{ pathRef: "a.txt", changeType: "create", afterHash }],
      }),
    ).rejects.toThrow(FileChangeValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. FileChange 查询 + 跨租户隔离
// ═══════════════════════════════════════════════════════════

describe("V11 FileChange 查询 + 跨租户隔离", () => {
  it("getFileChangeById：跨租户返回 null", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    const changes = await createFileChanges({
      tenantId,
      toolCallId: toolCall.id,
      workspaceBindingId: binding.id,
      changes: [{ pathRef: "a.txt", changeType: "create", afterHash }],
    });

    const found = await getFileChangeById(tenantId, changes[0]?.id ?? "");
    expect(found?.id).toBe(changes[0]?.id);

    const other = await getFileChangeById(randomUUID(), changes[0]?.id ?? "");
    expect(other).toBeNull();
  });

  it("listFileChangesByToolCall：按 createdAt 升序 + 跨租户返回空", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    await createFileChanges({
      tenantId,
      toolCallId: toolCall.id,
      workspaceBindingId: binding.id,
      changes: [
        { pathRef: "a.txt", changeType: "create", afterHash },
        { pathRef: "b.txt", changeType: "create", afterHash },
      ],
    });

    const list = await listFileChangesByToolCall(tenantId, toolCall.id);
    expect(list).toHaveLength(2);

    const other = await listFileChangesByToolCall(randomUUID(), toolCall.id);
    expect(other).toEqual([]);
  });

  it("listFileChangesByWorkspaceBinding：按 createdAt 降序 + limit", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall1 = await seedToolCall(tenantId);
    const toolCall2 = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    await createFileChanges({
      tenantId,
      toolCallId: toolCall1.id,
      workspaceBindingId: binding.id,
      changes: [{ pathRef: "a.txt", changeType: "create", afterHash }],
    });
    await createFileChanges({
      tenantId,
      toolCallId: toolCall2.id,
      workspaceBindingId: binding.id,
      changes: [{ pathRef: "b.txt", changeType: "create", afterHash }],
    });

    const list = await listFileChangesByWorkspaceBinding(tenantId, binding.id);
    expect(list).toHaveLength(2);

    const limited = await listFileChangesByWorkspaceBinding(tenantId, binding.id, { limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. linkFileChangeToArtifact
// ═══════════════════════════════════════════════════════════

describe("V11 linkFileChangeToArtifact", () => {
  it("成功关联 FileChange 到 Artifact", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    const changes = await createFileChanges({
      tenantId,
      toolCallId: toolCall.id,
      workspaceBindingId: binding.id,
      changes: [{ pathRef: "a.txt", changeType: "create", afterHash }],
    });
    const artifact = await createArtifact(buildArtifactInput(tenantId, randomUUID()));

    const linked = await linkFileChangeToArtifact(tenantId, changes[0]?.id ?? "", artifact.id);
    expect(linked.artifactId).toBe(artifact.id);

    // 反查 Artifact 应能找到关联的 FileChange
    const list = await listFileChangesByArtifact(tenantId, artifact.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(changes[0]?.id);
  });

  it("已关联的 FileChange 重复关联 → FileChangeValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    const changes = await createFileChanges({
      tenantId,
      toolCallId: toolCall.id,
      workspaceBindingId: binding.id,
      changes: [{ pathRef: "a.txt", changeType: "create", afterHash }],
    });
    const artifact1 = await createArtifact(buildArtifactInput(tenantId, randomUUID()));
    const artifact2 = await createArtifact(buildArtifactInput(tenantId, randomUUID()));

    await linkFileChangeToArtifact(tenantId, changes[0]?.id ?? "", artifact1.id);
    await expect(
      linkFileChangeToArtifact(tenantId, changes[0]?.id ?? "", artifact2.id),
    ).rejects.toThrow(FileChangeValidationError);
  });

  it("FileChange 不存在 → FileChangeNotFoundError", async () => {
    const tenantId = await seedTenant();
    const artifact = await createArtifact(buildArtifactInput(tenantId, randomUUID()));

    await expect(linkFileChangeToArtifact(tenantId, randomUUID(), artifact.id)).rejects.toThrow(
      FileChangeNotFoundError,
    );
  });

  it("跨租户 → FileChangeNotFoundError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const toolCall = await seedToolCall(tenantId);
    const afterHash = buildValidHash("after");

    const changes = await createFileChanges({
      tenantId,
      toolCallId: toolCall.id,
      workspaceBindingId: binding.id,
      changes: [{ pathRef: "a.txt", changeType: "create", afterHash }],
    });

    await expect(
      linkFileChangeToArtifact(randomUUID(), changes[0]?.id ?? "", randomUUID()),
    ).rejects.toThrow(FileChangeNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. createFilesystemCheckpoint：成功 + 校验
// ═══════════════════════════════════════════════════════════

describe("V11 createFilesystemCheckpoint：成功 + 校验", () => {
  it("成功创建 + 默认值填充", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const invocationId = randomUUID();
    const contentHash = buildValidHash("checkpoint-content");

    const checkpoint = await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding.id,
      invocationId,
      checkpointType: "git",
      checkpointRef: `s3://checkpoints/${randomUUID()}`,
      baseRevisionRef: "abc123def456",
      contentHash,
    });

    expect(checkpoint.tenantId).toBe(tenantId);
    expect(checkpoint.workspaceBindingId).toBe(binding.id);
    expect(checkpoint.invocationId).toBe(invocationId);
    expect(checkpoint.checkpointType).toBe("git");
    expect(checkpoint.baseRevisionRef).toBe("abc123def456");
    expect(checkpoint.contentHash).toBe(contentHash);
    expect(checkpoint.expiresAt).toBeNull();
    expect(checkpoint.createdAt).toBeInstanceOf(Date);
  });

  it("带 expiresAt 创建", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const futureExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const checkpoint = await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding.id,
      invocationId: randomUUID(),
      checkpointType: "tarball",
      checkpointRef: `s3://checkpoints/${randomUUID()}.tar.gz`,
      contentHash: buildValidHash("content"),
      expiresAt: futureExpires,
    });

    expect(checkpoint.expiresAt).toEqual(futureExpires);
  });

  it("空 tenantId / workspaceBindingId / invocationId → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);

    await expect(
      createFilesystemCheckpoint({
        tenantId: "",
        workspaceBindingId: binding.id,
        invocationId: randomUUID(),
        checkpointType: "git",
        checkpointRef: "s3://x",
        contentHash: buildValidHash("x"),
      }),
    ).rejects.toThrow(FilesystemCheckpointValidationError);

    await expect(
      createFilesystemCheckpoint({
        tenantId,
        workspaceBindingId: "",
        invocationId: randomUUID(),
        checkpointType: "git",
        checkpointRef: "s3://x",
        contentHash: buildValidHash("x"),
      }),
    ).rejects.toThrow(FilesystemCheckpointValidationError);

    await expect(
      createFilesystemCheckpoint({
        tenantId,
        workspaceBindingId: binding.id,
        invocationId: "",
        checkpointType: "git",
        checkpointRef: "s3://x",
        contentHash: buildValidHash("x"),
      }),
    ).rejects.toThrow(FilesystemCheckpointValidationError);
  });

  it("非法 contentHash 格式 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);

    await expect(
      createFilesystemCheckpoint({
        tenantId,
        workspaceBindingId: binding.id,
        invocationId: randomUUID(),
        checkpointType: "git",
        checkpointRef: "s3://x",
        contentHash: "md5:abc",
      }),
    ).rejects.toThrow(FilesystemCheckpointValidationError);
  });

  it("checkpointRef 为公网 URL → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);

    await expect(
      createFilesystemCheckpoint({
        tenantId,
        workspaceBindingId: binding.id,
        invocationId: randomUUID(),
        checkpointType: "git",
        checkpointRef: "https://example.com/checkpoint.tar.gz",
        contentHash: buildValidHash("x"),
      }),
    ).rejects.toThrow(FilesystemCheckpointValidationError);
  });

  it("非法 checkpointType → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);

    await expect(
      createFilesystemCheckpoint({
        tenantId,
        workspaceBindingId: binding.id,
        invocationId: randomUUID(),
        checkpointType: "diff" as never,
        checkpointRef: "s3://x",
        contentHash: buildValidHash("x"),
      }),
    ).rejects.toThrow(FilesystemCheckpointValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. FilesystemCheckpoint 查询 + getLatest + 跨租户隔离
// ═══════════════════════════════════════════════════════════

describe("V11 FilesystemCheckpoint 查询 + 跨租户隔离", () => {
  it("getFilesystemCheckpointById：跨租户返回 null", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const checkpoint = await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding.id,
      invocationId: randomUUID(),
      checkpointType: "git",
      checkpointRef: `s3://cp/${randomUUID()}`,
      contentHash: buildValidHash("x"),
    });

    const found = await getFilesystemCheckpointById(tenantId, checkpoint.id);
    expect(found?.id).toBe(checkpoint.id);

    const other = await getFilesystemCheckpointById(randomUUID(), checkpoint.id);
    expect(other).toBeNull();
  });

  it("listFilesystemCheckpointsByInvocation：按 createdAt 降序 + 跨租户返回空", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);
    const invocationId = randomUUID();

    const cp1 = await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding.id,
      invocationId,
      checkpointType: "git",
      checkpointRef: `s3://cp/${randomUUID()}`,
      contentHash: buildValidHash("1"),
    });
    const cp2 = await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding.id,
      invocationId,
      checkpointType: "tarball",
      checkpointRef: `s3://cp/${randomUUID()}`,
      contentHash: buildValidHash("2"),
    });

    const list = await listFilesystemCheckpointsByInvocation(tenantId, invocationId);
    expect(list).toHaveLength(2);
    // 降序：cp2 在前
    expect(list[0]?.id).toBe(cp2.id);
    expect(list[1]?.id).toBe(cp1.id);

    const other = await listFilesystemCheckpointsByInvocation(randomUUID(), invocationId);
    expect(other).toEqual([]);
  });

  it("listFilesystemCheckpointsByWorkspaceBinding：按 binding 过滤", async () => {
    const tenantId = await seedTenant();
    const { binding: binding1 } = await seedWorkspaceAndBinding(tenantId);
    const { binding: binding2 } = await seedWorkspaceAndBinding(tenantId);

    await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding1.id,
      invocationId: randomUUID(),
      checkpointType: "git",
      checkpointRef: `s3://cp/${randomUUID()}`,
      contentHash: buildValidHash("1"),
    });
    await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding2.id,
      invocationId: randomUUID(),
      checkpointType: "git",
      checkpointRef: `s3://cp/${randomUUID()}`,
      contentHash: buildValidHash("2"),
    });

    const list1 = await listFilesystemCheckpointsByWorkspaceBinding(tenantId, binding1.id);
    expect(list1).toHaveLength(1);
    expect(list1[0]?.workspaceBindingId).toBe(binding1.id);

    const list2 = await listFilesystemCheckpointsByWorkspaceBinding(tenantId, binding2.id);
    expect(list2).toHaveLength(1);
    expect(list2[0]?.workspaceBindingId).toBe(binding2.id);
  });

  it("getLatestFilesystemCheckpoint：返回最近一条", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);

    await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding.id,
      invocationId: randomUUID(),
      checkpointType: "git",
      checkpointRef: `s3://cp/${randomUUID()}`,
      contentHash: buildValidHash("1"),
    });
    const latest = await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding.id,
      invocationId: randomUUID(),
      checkpointType: "tarball",
      checkpointRef: `s3://cp/${randomUUID()}`,
      contentHash: buildValidHash("2"),
    });

    const result = await getLatestFilesystemCheckpoint(tenantId, binding.id);
    expect(result?.id).toBe(latest.id);
  });

  it("getLatestFilesystemCheckpoint：无记录返回 null", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);

    const result = await getLatestFilesystemCheckpoint(tenantId, binding.id);
    expect(result).toBeNull();
  });

  it("getLatestFilesystemCheckpoint：跨租户返回 null", async () => {
    const tenantId = await seedTenant();
    const { binding } = await seedWorkspaceAndBinding(tenantId);

    await createFilesystemCheckpoint({
      tenantId,
      workspaceBindingId: binding.id,
      invocationId: randomUUID(),
      checkpointType: "git",
      checkpointRef: `s3://cp/${randomUUID()}`,
      contentHash: buildValidHash("1"),
    });

    const result = await getLatestFilesystemCheckpoint(randomUUID(), binding.id);
    expect(result).toBeNull();
  });
});
