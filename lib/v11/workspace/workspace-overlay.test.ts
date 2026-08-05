/**
 * S09-C07：V11 Workspace Overlay 仓储集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - createWorkspaceOverlay（3 例）：成功 + created Event / git_worktree 与 cloud_overlay 类型 /
 *   UNIQUE(relation, binding) 冲突（同关系重复创建）
 * - mergeWorkspaceOverlay（3 例）：成功 + merged Event / 非 active 抛 StateError /
 *   不存在抛 NotFoundError
 * - reportWorkspaceMergeConflict（3 例）：成功报告 + overlay → conflict + 多冲突记录 /
 *   非 active 抛 StateError / 空 conflicts 列表抛错
 * - resolveWorkspaceMergeConflict（3 例）：成功 resolve + mergedRevisionRef 时转 merged /
 *   无 mergedRevisionRef 时保持 conflict / 非 conflict 抛 StateError
 * - abandonWorkspaceOverlay（3 例）：从 active 直接 abandon / 从 conflict abandon 时 conflict 行 abandoned /
 *   merged/discarded 抛 StateError
 * - 查询辅助（2 例）：getOverlaysByRelation / getOverlaysByBinding / getMergeConflictsByOverlay
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  WorkspaceOverlayNotFoundError,
  WorkspaceOverlayStateError,
} from "@/lib/v11/conversation/errors";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { registerDevice } from "@/lib/identity/device-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { v11ThreadRelation } from "@/lib/v11/schema/conversation";
import { v11Invocation } from "@/lib/v11/schema/runtime";
import {
  abandonWorkspaceOverlay,
  createWorkspaceOverlay,
  getMergeConflictsByOverlay,
  getOverlaysByBinding,
  getOverlaysByRelation,
  getWorkspaceOverlay,
  mergeWorkspaceOverlay,
  reportWorkspaceMergeConflict,
  resolveWorkspaceMergeConflict,
} from "@/lib/v11/workspace/workspace-overlay-queries";
import { createWorkspace, createWorkspaceBinding } from "@/lib/v11/workspace/workspace-queries";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 默认租户 + 用户身份 + 主体绑定 + Device + Threads + Relation ──

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: "overlay-user-1",
    email: "overlay-user-1@example.com",
    displayName: "Overlay User",
  });
  const binding = await upsertPrincipalBinding({
    tenantId: t.id,
    subjectType: "user",
    externalId: "overlay-user-1",
    displayName: "Overlay User",
    userIdentityId: identity.id,
  });
  return { tenantId: t.id, userId: identity.id, principalBindingId: binding.id };
}

async function seedDevice(tenantId: string, userId: string) {
  return registerDevice({
    tenantId,
    userId,
    deviceKey: "device-overlay-test",
    publicKey: "ed25519:fake-public-key-for-test-only-not-real",
    deviceName: "Overlay Test Device",
    appVersion: "1.0.0",
  });
}

async function seedThread(tenantId: string, userId: string, agentId: string) {
  const { thread } = await createThread({
    tenantId,
    ownerUserId: userId,
    primaryAgentId: agentId,
    title: "Overlay Test Thread",
    actorId: userId,
  });
  return thread;
}

/**
 * 直接 INSERT 一个最小 Invocation 行（绕过 createInvocation 的复杂依赖链）。
 * workspaceOverlay 创建时通过 invocationId 反查 threadId 写 ThreadEvent。
 */
async function seedMinimalInvocation(
  tenantId: string,
  threadId: string,
  sequence = 1,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(v11Invocation).values({
    id,
    tenantId,
    threadId,
    turnId: null,
    jobId: null,
    invocationSequence: sequence,
    invocationKind: "initial",
    executionState: "running",
    triggerItemId: null,
    replacesInvocationId: null,
    outputItemId: null,
    resultRef: null,
    runtimeSessionBindingId: null,
    runtimeExecutionRef: null,
    startedAt: now,
    finishedAt: null,
    lastHeartbeatAt: now,
    errorCode: null,
    errorSummary: null,
    versionNo: 1,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** 直接 INSERT 一个最小 ThreadRelation 行（delegate 类型，active 状态）。 */
async function seedMinimalRelation(
  tenantId: string,
  parentThreadId: string,
  childThreadId: string,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(v11ThreadRelation).values({
    id,
    parentThreadId,
    childThreadId,
    relationType: "delegate",
    sourceTurnId: null,
    sourceItemId: null,
    sourceInvocationId: null,
    targetAgentId: null,
    taskPayloadRef: null,
    taskPayloadHash: null,
    contextTransferPolicyJson: null,
    budgetPolicyJson: null,
    budgetUsedJson: null,
    relationState: "active",
    itemId: null,
    resultItemId: null,
    resultRef: null,
    resultHash: null,
    createdAt: now,
    completedAt: null,
  });
  return id;
}

async function seedCloudBinding(tenantId: string, userId: string) {
  const ws = await createWorkspace({
    tenantId,
    workspaceKey: "overlay-ws",
    displayName: "Overlay WS",
    ownerUserId: userId,
  });
  return createWorkspaceBinding({
    tenantId,
    workspaceId: ws.id,
    bindingType: "cloud",
    locationRef: "s3://my-bucket/overlay-project",
  });
}

const TEST_PARENT_AGENT_ID = "00000000-0000-4000-8000-000000000010";
const TEST_CHILD_AGENT_ID = "00000000-0000-4000-8000-000000000011";

async function seedFullContext(tenantId: string, userId: string) {
  const parentThread = await seedThread(tenantId, userId, TEST_PARENT_AGENT_ID);
  const childThread = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
  const relationId = await seedMinimalRelation(tenantId, parentThread.id, childThread.id);
  const binding = await seedCloudBinding(tenantId, userId);
  const invocationId = await seedMinimalInvocation(tenantId, parentThread.id);
  return { parentThread, childThread, relationId, binding, invocationId };
}

// ═══════════════════════════════════════════════════════════
// 1. createWorkspaceOverlay
// ═══════════════════════════════════════════════════════════

describe("S09-C07 createWorkspaceOverlay", () => {
  it("成功创建 Overlay + overlayState=active + ThreadEvent", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const result = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/overlay-1",
      overlayFingerprint: "sha256:overlay-1",
      baseRevisionRef: "git:abc123",
      taskDescription: "前端重构",
      invocationId,
    });

    expect(result.overlay.id).toBeTruthy();
    expect(result.overlay.overlayType).toBe("git_worktree");
    expect(result.overlay.overlayState).toBe("active");
    expect(result.overlay.parentWorkspaceBindingId).toBe(binding.id);
    expect(result.overlay.relationId).toBe(relationId);
    expect(result.overlay.baseRevisionRef).toBe("git:abc123");
    expect(result.overlay.taskDescription).toBe("前端重构");
    expect(result.createdEvent).not.toBeNull();
  });

  it("cloud_overlay 类型同样支持", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const result = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "cloud_overlay",
      overlayLocationRef: "cloud://overlay/snapshot-1",
      overlayFingerprint: "sha256:cloud-1",
      invocationId,
    });

    expect(result.overlay.overlayType).toBe("cloud_overlay");
    expect(result.overlay.overlayState).toBe("active");
  });

  it("UNIQUE(binding, relation) 冲突：同关系重复创建抛错", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/overlay-2",
      overlayFingerprint: "sha256:overlay-2",
      invocationId,
    });

    // 同 binding + relation 再次创建应抛 DB UNIQUE 错误
    await expect(
      createWorkspaceOverlay({
        tenantId,
        parentWorkspaceBindingId: binding.id,
        relationId,
        overlayType: "git_worktree",
        overlayLocationRef: "git://repo@sha/overlay-3",
        overlayFingerprint: "sha256:overlay-3",
        invocationId,
      }),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. mergeWorkspaceOverlay
// ═══════════════════════════════════════════════════════════

describe("S09-C07 mergeWorkspaceOverlay", () => {
  it("成功合并 + overlayState=merged + mergedRevisionRef", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/merge-1",
      overlayFingerprint: "sha256:merge-1",
      invocationId,
    });

    const merged = await mergeWorkspaceOverlay({
      tenantId,
      overlayId: overlay.id,
      mergedRevisionRef: "git:merged-rev-1",
      invocationId,
    });

    expect(merged.overlayState).toBe("merged");
    expect(merged.mergedRevisionRef).toBe("git:merged-rev-1");
    expect(merged.mergedAt).toBeInstanceOf(Date);
  });

  it("非 active 状态（已 conflict）抛 WorkspaceOverlayStateError", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/conflict-1",
      overlayFingerprint: "sha256:conflict-1",
      invocationId,
    });

    // 报告冲突 → conflict 状态
    await reportWorkspaceMergeConflict({
      tenantId,
      overlayId: overlay.id,
      invocationId,
      conflicts: [
        {
          conflictPathRef: "file://project/conflict.ts",
          pathFingerprint: "sha256:conflict-path",
        },
      ],
    });

    // conflict 状态下 merge 抛错
    await expect(
      mergeWorkspaceOverlay({
        tenantId,
        overlayId: overlay.id,
        mergedRevisionRef: "git:invalid-merge",
        invocationId,
      }),
    ).rejects.toBeInstanceOf(WorkspaceOverlayStateError);
  });

  it("不存在 → WorkspaceOverlayNotFoundError", async () => {
    const { tenantId, userId } = await seedContext();
    const { invocationId } = await seedFullContext(tenantId, userId);

    await expect(
      mergeWorkspaceOverlay({
        tenantId,
        overlayId: "00000000-0000-4000-8000-000000000099",
        mergedRevisionRef: "git:nonexistent",
        invocationId,
      }),
    ).rejects.toBeInstanceOf(WorkspaceOverlayNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. reportWorkspaceMergeConflict
// ═══════════════════════════════════════════════════════════

describe("S09-C07 reportWorkspaceMergeConflict", () => {
  it("成功报告冲突 + overlay → conflict + 多条 conflict 行", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/report-1",
      overlayFingerprint: "sha256:report-1",
      invocationId,
    });

    const result = await reportWorkspaceMergeConflict({
      tenantId,
      overlayId: overlay.id,
      invocationId,
      conflicts: [
        {
          conflictPathRef: "file://project/a.ts",
          pathFingerprint: "sha256:a",
          beforeHash: "sha256:before-a",
          oursHash: "sha256:ours-a",
          theirsHash: "sha256:theirs-a",
        },
        {
          conflictPathRef: "file://project/b.ts",
          pathFingerprint: "sha256:b",
        },
      ],
    });

    expect(result.overlay.overlayState).toBe("conflict");
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.every((c) => c.conflictState === "reported")).toBe(true);
    expect(result.conflicts[0]?.conflictPathRef).toBe("file://project/a.ts");
    expect(result.conflicts[0]?.oursHash).toBe("sha256:ours-a");
  });

  it("非 active 状态（已 merged）抛 WorkspaceOverlayStateError", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/merged-2",
      overlayFingerprint: "sha256:merged-2",
      invocationId,
    });
    await mergeWorkspaceOverlay({
      tenantId,
      overlayId: overlay.id,
      mergedRevisionRef: "git:merged-rev-2",
      invocationId,
    });

    await expect(
      reportWorkspaceMergeConflict({
        tenantId,
        overlayId: overlay.id,
        invocationId,
        conflicts: [
          {
            conflictPathRef: "file://project/x.ts",
            pathFingerprint: "sha256:x",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(WorkspaceOverlayStateError);
  });

  it("空 conflicts 列表抛错", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/empty-conflicts",
      overlayFingerprint: "sha256:empty-conflicts",
      invocationId,
    });

    await expect(
      reportWorkspaceMergeConflict({
        tenantId,
        overlayId: overlay.id,
        invocationId,
        conflicts: [],
      }),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. resolveWorkspaceMergeConflict
// ═══════════════════════════════════════════════════════════

describe("S09-C07 resolveWorkspaceMergeConflict", () => {
  it("成功 resolve + 提供 mergedRevisionRef 时转 merged", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/resolve-1",
      overlayFingerprint: "sha256:resolve-1",
      invocationId,
    });
    await reportWorkspaceMergeConflict({
      tenantId,
      overlayId: overlay.id,
      invocationId,
      conflicts: [
        {
          conflictPathRef: "file://project/resolve.ts",
          pathFingerprint: "sha256:resolve",
        },
      ],
    });

    const resolved = await resolveWorkspaceMergeConflict({
      tenantId,
      overlayId: overlay.id,
      resolutionSummary: "手动合并：选择 theirs",
      mergedRevisionRef: "git:resolved-1",
      invocationId,
    });

    expect(resolved.overlayState).toBe("merged");
    expect(resolved.mergedRevisionRef).toBe("git:resolved-1");

    // 验证 conflict 行已 resolved
    const conflicts = await getMergeConflictsByOverlay(tenantId, overlay.id);
    expect(conflicts.every((c) => c.conflictState === "resolved")).toBe(true);
    expect(conflicts[0]?.resolutionSummary).toBe("手动合并：选择 theirs");
  });

  it("无 mergedRevisionRef 时保持 conflict 状态（仅 conflict 行 resolved）", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/resolve-2",
      overlayFingerprint: "sha256:resolve-2",
      invocationId,
    });
    await reportWorkspaceMergeConflict({
      tenantId,
      overlayId: overlay.id,
      invocationId,
      conflicts: [
        {
          conflictPathRef: "file://project/keep-conflict.ts",
          pathFingerprint: "sha256:keep",
        },
      ],
    });

    const resolved = await resolveWorkspaceMergeConflict({
      tenantId,
      overlayId: overlay.id,
      resolutionSummary: "标记 conflict 已解决，等待后续 merge",
      invocationId,
    });

    expect(resolved.overlayState).toBe("conflict"); // 仍为 conflict
    const conflicts = await getMergeConflictsByOverlay(tenantId, overlay.id);
    expect(conflicts.every((c) => c.conflictState === "resolved")).toBe(true);
  });

  it("非 conflict 状态（active）抛 WorkspaceOverlayStateError", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/active-resolve",
      overlayFingerprint: "sha256:active-resolve",
      invocationId,
    });

    // active 状态 resolve 抛错（需先 reportWorkspaceMergeConflict 转为 conflict）
    await expect(
      resolveWorkspaceMergeConflict({
        tenantId,
        overlayId: overlay.id,
        resolutionSummary: "测试",
        invocationId,
      }),
    ).rejects.toBeInstanceOf(WorkspaceOverlayStateError);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. abandonWorkspaceOverlay
// ═══════════════════════════════════════════════════════════

describe("S09-C07 abandonWorkspaceOverlay", () => {
  it("从 active 直接 abandon → discarded", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/abandon-active",
      overlayFingerprint: "sha256:abandon-active",
      invocationId,
    });

    const abandoned = await abandonWorkspaceOverlay({
      tenantId,
      overlayId: overlay.id,
      invocationId,
    });

    expect(abandoned.overlayState).toBe("discarded");
    expect(abandoned.discardedAt).toBeInstanceOf(Date);
  });

  it("从 conflict abandon 时 conflict 行转 abandoned", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/abandon-conflict",
      overlayFingerprint: "sha256:abandon-conflict",
      invocationId,
    });
    await reportWorkspaceMergeConflict({
      tenantId,
      overlayId: overlay.id,
      invocationId,
      conflicts: [
        {
          conflictPathRef: "file://project/abandon.ts",
          pathFingerprint: "sha256:abandon",
        },
      ],
    });

    const abandoned = await abandonWorkspaceOverlay({
      tenantId,
      overlayId: overlay.id,
      invocationId,
    });

    expect(abandoned.overlayState).toBe("discarded");

    // 验证 conflict 行已 abandoned
    const conflicts = await getMergeConflictsByOverlay(tenantId, overlay.id);
    expect(conflicts.every((c) => c.conflictState === "abandoned")).toBe(true);
  });

  it("merged 状态抛 WorkspaceOverlayStateError", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/abandon-merged",
      overlayFingerprint: "sha256:abandon-merged",
      invocationId,
    });
    await mergeWorkspaceOverlay({
      tenantId,
      overlayId: overlay.id,
      mergedRevisionRef: "git:abandon-merged-rev",
      invocationId,
    });

    await expect(
      abandonWorkspaceOverlay({
        tenantId,
        overlayId: overlay.id,
        invocationId,
      }),
    ).rejects.toBeInstanceOf(WorkspaceOverlayStateError);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 查询辅助
// ═══════════════════════════════════════════════════════════

describe("S09-C07 查询辅助", () => {
  it("getWorkspaceOverlay / getOverlaysByRelation / getOverlaysByBinding", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/query-1",
      overlayFingerprint: "sha256:query-1",
      invocationId,
    });

    // getWorkspaceOverlay
    const found = await getWorkspaceOverlay(tenantId, overlay.id);
    expect(found?.id).toBe(overlay.id);
    const crossTenant = await getWorkspaceOverlay(
      "00000000-0000-4000-8000-000000000099",
      overlay.id,
    );
    expect(crossTenant).toBeNull();

    // getOverlaysByRelation
    const byRelation = await getOverlaysByRelation(tenantId, relationId);
    expect(byRelation).toHaveLength(1);
    expect(byRelation[0]?.id).toBe(overlay.id);

    // getOverlaysByBinding
    const byBinding = await getOverlaysByBinding(tenantId, binding.id);
    expect(byBinding).toHaveLength(1);
    expect(byBinding[0]?.id).toBe(overlay.id);
  });

  it("getMergeConflictsByOverlay 按 conflictState 过滤", async () => {
    const { tenantId, userId } = await seedContext();
    const { relationId, binding, invocationId } = await seedFullContext(tenantId, userId);

    const { overlay } = await createWorkspaceOverlay({
      tenantId,
      parentWorkspaceBindingId: binding.id,
      relationId,
      overlayType: "git_worktree",
      overlayLocationRef: "git://repo@sha/conflict-query",
      overlayFingerprint: "sha256:conflict-query",
      invocationId,
    });
    await reportWorkspaceMergeConflict({
      tenantId,
      overlayId: overlay.id,
      invocationId,
      conflicts: [
        {
          conflictPathRef: "file://project/c1.ts",
          pathFingerprint: "sha256:c1",
        },
        {
          conflictPathRef: "file://project/c2.ts",
          pathFingerprint: "sha256:c2",
        },
      ],
    });

    // 全部
    const all = await getMergeConflictsByOverlay(tenantId, overlay.id);
    expect(all).toHaveLength(2);

    // 仅 reported
    const reportedOnly = await getMergeConflictsByOverlay(tenantId, overlay.id, "reported");
    expect(reportedOnly).toHaveLength(2);

    // 仅 resolved（应为空）
    const resolvedOnly = await getMergeConflictsByOverlay(tenantId, overlay.id, "resolved");
    expect(resolvedOnly).toHaveLength(0);

    // 解决后再查 resolved
    await resolveWorkspaceMergeConflict({
      tenantId,
      overlayId: overlay.id,
      resolutionSummary: "解决",
      mergedRevisionRef: "git:resolved",
      invocationId,
    });
    const afterResolve = await getMergeConflictsByOverlay(tenantId, overlay.id, "resolved");
    expect(afterResolve).toHaveLength(2);
  });
});
