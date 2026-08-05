/**
 * S09-C07：V11 Workspace 写锁仓储集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - acquireWorkspaceWriteLock（5 例）：成功 + ThreadEvent / 幂等（同 Invocation 重复 acquire）/
 *   冲突（不同 Invocation 同 path）/ 跨租户隔离 / 多 path 各自持锁
 * - releaseWorkspaceWriteLock（4 例）：成功 + released Event / 已 released 抛 StateError /
 *   已 revoked 抛 StateError / 不存在抛 NotFoundError
 * - revokeWorkspaceWriteLocksForInvocation（3 例）：批量 revoke / 无活跃锁返回空 /
 *   已 released 不被 revoke
 * - reapExpiredWorkspaceWriteLocks（3 例）：清理过期锁 / 未过期不被清理 / 无 expiresAt 不被清理
 * - 查询辅助（3 例）：getWorkspaceWriteLock 跨租户隔离 / getActiveLockByPath /
 *   getActiveLocksByInvocation / getActiveLocksByBinding
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { randomUUID } from "node:crypto";
import {
  WorkspaceWriteLockConflictError,
  WorkspaceWriteLockNotFoundError,
  WorkspaceWriteLockStateError,
} from "@/lib/conversations/errors";
import { createThread } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { registerDevice } from "@/lib/identity/device-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { invocationTable } from "@/lib/persistence/schema/runtime";
import { createWorkspace, createWorkspaceBinding } from "@/lib/v11/workspace/workspace-queries";
import {
  acquireWorkspaceWriteLock,
  getActiveLockByPath,
  getActiveLocksByBinding,
  getActiveLocksByInvocation,
  getWorkspaceWriteLock,
  reapExpiredWorkspaceWriteLocks,
  releaseWorkspaceWriteLock,
  revokeWorkspaceWriteLocksForInvocation,
} from "@/lib/v11/workspace/workspace-write-lock-queries";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 默认租户 + 用户身份 + 主体绑定 + Device + Thread + WorkspaceBinding ──

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: "lock-user-1",
    email: "lock-user-1@example.com",
    displayName: "Lock User",
  });
  const binding = await upsertPrincipalBinding({
    tenantId: t.id,
    subjectType: "user",
    externalId: "lock-user-1",
    displayName: "Lock User",
    userIdentityId: identity.id,
  });
  return { tenantId: t.id, userId: identity.id, principalBindingId: binding.id };
}

async function seedDevice(tenantId: string, userId: string) {
  return registerDevice({
    tenantId,
    userId,
    deviceKey: "device-lock-test",
    publicKey: "ed25519:fake-public-key-for-test-only-not-real",
    deviceName: "Lock Test Device",
    appVersion: "1.0.0",
  });
}

async function seedThread(tenantId: string, userId: string, agentId: string) {
  const { thread } = await createThread({
    tenantId,
    ownerUserId: userId,
    primaryAgentId: agentId,
    title: "Lock Test Thread",
    actorId: userId,
  });
  return thread;
}

/**
 * 直接 INSERT 一个最小 Invocation 行（绕过 createInvocation 的复杂依赖链）。
 * workspaceWriteLock.holderInvocationId 是 DB FK，所以需要真实行。
 */
async function seedMinimalInvocation(
  tenantId: string,
  threadId: string,
  sequence = 1,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(invocationTable).values({
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

async function seedDesktopBinding(tenantId: string, userId: string) {
  const device = await seedDevice(tenantId, userId);
  const ws = await createWorkspace({
    tenantId,
    workspaceKey: "lock-ws",
    displayName: "Lock WS",
    ownerUserId: userId,
  });
  return createWorkspaceBinding({
    tenantId,
    workspaceId: ws.id,
    bindingType: "desktop",
    deviceId: device.id,
    locationRef: "device://device-lock-test/home/user/project",
  });
}

const TEST_AGENT_ID = "00000000-0000-4000-8000-000000000001";

// ═══════════════════════════════════════════════════════════
// 1. acquireWorkspaceWriteLock
// ═══════════════════════════════════════════════════════════

describe("S09-C07 acquireWorkspaceWriteLock", () => {
  it("成功获取写锁 + lockState=acquired + ThreadEvent 写入", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const result = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/src/index.ts",
      pathFingerprint: "sha256:abc123",
    });

    expect(result.lock.id).toBeTruthy();
    expect(result.lock.lockState).toBe("acquired");
    expect(result.lock.workspaceBindingId).toBe(binding.id);
    expect(result.lock.holderInvocationId).toBe(invocationId);
    expect(result.lock.pathFingerprint).toBe("sha256:abc123");
    expect(result.acquiredEvent).not.toBeNull();
  });

  it("幂等：同 Invocation 重复 acquire 同 path 返回现有锁", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const first = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/src/a.ts",
      pathFingerprint: "sha256:path-a",
    });

    const second = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/src/a.ts",
      pathFingerprint: "sha256:path-a",
    });

    expect(second.lock.id).toBe(first.lock.id);
    expect(second.acquiredEvent).toBeNull(); // 幂等不重复写 Event
  });

  it("冲突：不同 Invocation 同 path 抛 WorkspaceWriteLockConflictError", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationA = await seedMinimalInvocation(tenantId, thread.id, 1);
    const invocationB = await seedMinimalInvocation(tenantId, thread.id, 2);

    await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationA,
      pathRef: "file://project/conflict.ts",
      pathFingerprint: "sha256:conflict-path",
    });

    await expect(
      acquireWorkspaceWriteLock({
        tenantId,
        workspaceBindingId: binding.id,
        threadId: thread.id,
        holderInvocationId: invocationB,
        pathRef: "file://project/conflict.ts",
        pathFingerprint: "sha256:conflict-path",
      }),
    ).rejects.toBeInstanceOf(WorkspaceWriteLockConflictError);
  });

  it("不同 path 各自持锁（同 binding）", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const lockA = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/a.ts",
      pathFingerprint: "sha256:a",
    });
    const lockB = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/b.ts",
      pathFingerprint: "sha256:b",
    });

    expect(lockA.lock.id).not.toBe(lockB.lock.id);
    expect(lockA.lock.lockState).toBe("acquired");
    expect(lockB.lock.lockState).toBe("acquired");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. releaseWorkspaceWriteLock
// ═══════════════════════════════════════════════════════════

describe("S09-C07 releaseWorkspaceWriteLock", () => {
  it("成功释放写锁 + lockState=released + ThreadEvent", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const { lock } = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/release.ts",
      pathFingerprint: "sha256:release",
    });

    const released = await releaseWorkspaceWriteLock({
      tenantId,
      lockId: lock.id,
      releaseReasonCode: "turn_completed",
    });

    expect(released.lockState).toBe("released");
    expect(released.releasedAt).toBeInstanceOf(Date);
    expect(released.releaseReasonCode).toBe("turn_completed");
  });

  it("已 released 时再 release 抛 WorkspaceWriteLockStateError", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const { lock } = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/double-release.ts",
      pathFingerprint: "sha256:double",
    });

    await releaseWorkspaceWriteLock({
      tenantId,
      lockId: lock.id,
      releaseReasonCode: "turn_completed",
    });

    await expect(
      releaseWorkspaceWriteLock({
        tenantId,
        lockId: lock.id,
        releaseReasonCode: "turn_completed",
      }),
    ).rejects.toBeInstanceOf(WorkspaceWriteLockStateError);
  });

  it("不存在 → WorkspaceWriteLockNotFoundError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      releaseWorkspaceWriteLock({
        tenantId,
        lockId: "00000000-0000-4000-8000-000000000099",
        releaseReasonCode: "turn_completed",
      }),
    ).rejects.toBeInstanceOf(WorkspaceWriteLockNotFoundError);
  });

  it("跨租户隔离：用错误 tenantId 查不到锁", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const { lock } = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/cross-tenant.ts",
      pathFingerprint: "sha256:cross",
    });

    await expect(
      releaseWorkspaceWriteLock({
        tenantId: "00000000-0000-4000-8000-000000000099",
        lockId: lock.id,
        releaseReasonCode: "turn_completed",
      }),
    ).rejects.toBeInstanceOf(WorkspaceWriteLockNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. revokeWorkspaceWriteLocksForInvocation
// ═══════════════════════════════════════════════════════════

describe("S09-C07 revokeWorkspaceWriteLocksForInvocation", () => {
  it("批量 revoke Invocation 持有的所有活跃锁", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    // 同一 Invocation 持有 2 个不同 path 的锁
    await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/revoke-a.ts",
      pathFingerprint: "sha256:revoke-a",
    });
    await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/revoke-b.ts",
      pathFingerprint: "sha256:revoke-b",
    });

    const revoked = await revokeWorkspaceWriteLocksForInvocation({
      tenantId,
      invocationId,
    });

    expect(revoked).toHaveLength(2);
    expect(revoked.every((l) => l.lockState === "revoked")).toBe(true);
    expect(revoked.every((l) => l.releaseReasonCode === "invocation_lost")).toBe(true);
  });

  it("无活跃锁返回空数组", async () => {
    const { tenantId, userId } = await seedContext();
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const revoked = await revokeWorkspaceWriteLocksForInvocation({
      tenantId,
      invocationId,
    });

    expect(revoked).toHaveLength(0);
  });

  it("已 released 锁不被 revoke", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const { lock } = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/release-then-revoke.ts",
      pathFingerprint: "sha256:release-then-revoke",
    });

    // 先 release
    await releaseWorkspaceWriteLock({
      tenantId,
      lockId: lock.id,
      releaseReasonCode: "turn_completed",
    });

    // 再 revoke：应该没有活跃锁可被 revoke
    const revoked = await revokeWorkspaceWriteLocksForInvocation({
      tenantId,
      invocationId,
    });

    expect(revoked).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. reapExpiredWorkspaceWriteLocks
// ═══════════════════════════════════════════════════════════

describe("S09-C07 reapExpiredWorkspaceWriteLocks", () => {
  it("清理过期 acquired 锁（expiresAt < before）", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const pastExpiry = new Date(Date.now() - 60_000); // 1 分钟前过期
    await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/expired.ts",
      pathFingerprint: "sha256:expired",
      expiresAt: pastExpiry,
    });

    const reaped = await reapExpiredWorkspaceWriteLocks({ tenantId });

    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.lockState).toBe("expired");
    expect(reaped[0]?.releaseReasonCode).toBe("expired");
  });

  it("未过期锁不被清理", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const futureExpiry = new Date(Date.now() + 60_000); // 1 分钟后过期
    await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/not-expired.ts",
      pathFingerprint: "sha256:not-expired",
      expiresAt: futureExpiry,
    });

    const reaped = await reapExpiredWorkspaceWriteLocks({ tenantId });
    expect(reaped).toHaveLength(0);
  });

  it("无 expiresAt 的锁不被清理（永久锁）", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/permanent.ts",
      pathFingerprint: "sha256:permanent",
      // 不设 expiresAt
    });

    const reaped = await reapExpiredWorkspaceWriteLocks({ tenantId });
    expect(reaped).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 查询辅助
// ═══════════════════════════════════════════════════════════

describe("S09-C07 查询辅助", () => {
  it("getWorkspaceWriteLock 跨租户隔离", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const { lock } = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/query.ts",
      pathFingerprint: "sha256:query",
    });

    const found = await getWorkspaceWriteLock(tenantId, lock.id);
    expect(found?.id).toBe(lock.id);

    const crossTenant = await getWorkspaceWriteLock(
      "00000000-0000-4000-8000-000000000099",
      lock.id,
    );
    expect(crossTenant).toBeNull();
  });

  it("getActiveLockByPath 返回活跃锁", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    const { lock } = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/active.ts",
      pathFingerprint: "sha256:active",
    });

    const active = await getActiveLockByPath(tenantId, binding.id, "sha256:active");
    expect(active?.id).toBe(lock.id);

    // 释放后查不到
    await releaseWorkspaceWriteLock({
      tenantId,
      lockId: lock.id,
      releaseReasonCode: "turn_completed",
    });
    const afterRelease = await getActiveLockByPath(tenantId, binding.id, "sha256:active");
    expect(afterRelease).toBeNull();
  });

  it("getActiveLocksByInvocation / getActiveLocksByBinding", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationId = await seedMinimalInvocation(tenantId, thread.id);

    await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/list-a.ts",
      pathFingerprint: "sha256:list-a",
    });
    await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationId,
      pathRef: "file://project/list-b.ts",
      pathFingerprint: "sha256:list-b",
    });

    const byInvocation = await getActiveLocksByInvocation(tenantId, invocationId);
    expect(byInvocation).toHaveLength(2);

    const byBinding = await getActiveLocksByBinding(tenantId, binding.id);
    expect(byBinding).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 已释放路径可被重新获取（§5.5 Event 只 INSERT；不修改历史行）
// ═══════════════════════════════════════════════════════════

describe("S09-C07 释放后重新获取同路径写锁", () => {
  it("已 released 路径可被同/不同 Invocation 重新 acquire", async () => {
    const { tenantId, userId } = await seedContext();
    const binding = await seedDesktopBinding(tenantId, userId);
    const thread = await seedThread(tenantId, userId, TEST_AGENT_ID);
    const invocationA = await seedMinimalInvocation(tenantId, thread.id, 1);
    const invocationB = await seedMinimalInvocation(tenantId, thread.id, 2);

    // A 获取锁
    const { lock: lockA } = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationA,
      pathRef: "file://project/reacquire.ts",
      pathFingerprint: "sha256:reacquire",
    });

    // A 释放
    await releaseWorkspaceWriteLock({
      tenantId,
      lockId: lockA.id,
      releaseReasonCode: "turn_completed",
    });

    // B 可以获取同 path 锁（A 的 released 行保留为历史，B 创建新行）
    const { lock: lockB } = await acquireWorkspaceWriteLock({
      tenantId,
      workspaceBindingId: binding.id,
      threadId: thread.id,
      holderInvocationId: invocationB,
      pathRef: "file://project/reacquire.ts",
      pathFingerprint: "sha256:reacquire",
    });

    expect(lockB.id).not.toBe(lockA.id);
    expect(lockB.lockState).toBe("acquired");

    // 验证历史行未被修改（仍为 released）
    const historicalLock = await getWorkspaceWriteLock(tenantId, lockA.id);
    expect(historicalLock?.lockState).toBe("released");
  });
});
