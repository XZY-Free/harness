import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import {
  closeExecutionOwnership,
  getActiveExecutionOwnership,
} from "@/lib/executions/persistence/execution-ownership-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { registerDevice } from "@/lib/identity/device-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { executionOwnershipTable, invocationTable } from "@/lib/persistence/schema/executions";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { type WorkspaceBackend, createWorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { cleanupWorkspaceCandidate } from "@/lib/workspace/workspace-cleanup";
import {
  assertWorkspaceContinuity,
  computeWorkspaceContractDigest,
} from "@/lib/workspace/workspace-contract";
import { type WorkspaceHost, createManagedWorkspaceHost } from "@/lib/workspace/workspace-host";
import { createWorkspace, createWorkspaceBinding } from "@/lib/workspace/workspace-queries";
import { requireWorkspaceReadiness } from "@/lib/workspace/workspace-readiness";
import {
  activateWorkspaceWriter,
  reserveWorkspaceWriter,
  revokeWorkspaceWriteLocksForInvocation,
} from "@/lib/workspace/workspace-write-lock-queries";
import {
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
} from "@/lib/workspace/workspace-writer";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";

const desktopSemantics = {
  kind: "desktop",
  caseSensitive: true,
  symlinks: true,
  permissions: true,
  hardlinks: true,
  specialFiles: false,
  xattrsAcl: true,
  mtime: "preserved",
} as const;

function expectThrownName(fn: () => unknown, name: string) {
  try {
    fn();
  } catch (error) {
    expect((error as Error).name).toBe(name);
    return;
  }
  throw new Error(`期望抛出 ${name}，但调用成功返回`);
}

async function createTestBinding(input: {
  root: string;
  continuityMode: "HOST_AFFINE" | "SHARED_DURABLE" | "CHECKPOINT_RESTORABLE";
  storageIdentity: string;
  hostIdentity: string;
  bindingType?: "desktop" | "cloud" | "remote" | "sandbox";
  deviceId?: string | null;
}) {
  const logical = await createWorkspace({
    tenantId: TENANT_ID,
    workspaceKey: `continuity-${randomUUID()}`,
    displayName: "Continuity fixture",
  });
  const storageScopeDigest = protocolDigest({ scope: input.root });
  const binding = await createWorkspaceBinding({
    tenantId: TENANT_ID,
    workspaceId: logical.id,
    continuityMode: input.continuityMode,
    bindingType: input.bindingType ?? "sandbox",
    deviceId: input.deviceId ?? null,
    locationRef: `managed://continuity-${randomUUID()}`,
    storageScopeDigest,
    backendKind: "managed_host",
    hostIdentity: input.hostIdentity,
    storageIdentity: input.storageIdentity,
    accessMode: "read_write",
    filesystemSemantics: desktopSemantics,
    checkpointPolicy:
      input.continuityMode === "CHECKPOINT_RESTORABLE"
        ? {
            safePointTimeoutSeconds: 120,
            chunkBytes: 4_194_304,
            maxTotalBytes: "10737418240",
            maxEntries: 100_000,
            trigger: "before_suspend_and_explicit",
            retention: "retain_while_referenced",
          }
        : null,
    contractDigest: computeWorkspaceContractDigest({
      bindingId: "fixture",
      continuityMode: input.continuityMode,
      storageScopeDigest,
      hostIdentity: input.hostIdentity,
      storageIdentity: input.storageIdentity,
      backendKind: "managed_host",
      filesystemSemantics: desktopSemantics,
      checkpointPolicy:
        input.continuityMode === "CHECKPOINT_RESTORABLE"
          ? {
              safePointTimeoutSeconds: 120,
              chunkBytes: 4_194_304,
              maxTotalBytes: "10737418240",
              maxEntries: 100_000,
              trigger: "before_suspend_and_explicit",
              retention: "retain_while_referenced",
            }
          : null,
    }),
    createdBy: "test-service",
  });
  return { binding, storageScopeDigest };
}

async function prepareAndActivate(input: {
  fixture: Awaited<ReturnType<typeof seedPreparedRuntimeAttempt>>;
  binding: Awaited<ReturnType<typeof createTestBinding>>["binding"];
  backend: WorkspaceBackend;
  root: string;
}) {
  const candidate = await prepareWorkspaceCandidate({
    attemptId: input.fixture.attempt.id,
    binding: input.binding,
    backend: input.backend,
    root: input.root,
    operationId: `continuity:${input.fixture.attempt.id}`,
    runtimeRevisionId: input.fixture.binding.runtimeRevisionId,
  });
  if (!candidate) throw new Error("candidate missing");
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: TENANT_ID,
    invocationId: input.fixture.invocation.id,
    attemptId: input.fixture.attempt.id,
    runtimeRevisionId: input.fixture.binding.runtimeRevisionId,
  });
  const activated = await activatePreparedWorkspaceWriter({
    tenantId: TENANT_ID,
    invocationId: input.fixture.invocation.id,
    attemptId: input.fixture.attempt.id,
    ownership: acquired.ownership,
    authority: acquired.authority,
    candidate,
  });
  return { acquired, activated, candidate };
}

describe("Workspace continuity integration", () => {
  let temporaryRoot = "";

  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "snowharness-continuity-"));
  });

  it("WORKSPACE-01: after a runtime process death the same host restores files and mints the next legal generation", async () => {
    try {
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
        storageIdentity: protocolDigest({ storage: temporaryRoot }),
        hostIdentity: "continuity-host-a",
      });
      const backend = createWorkspaceBackend(createManagedWorkspaceHost(temporaryRoot));
      const first = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const firstRun = await prepareAndActivate({
        fixture: first,
        binding,
        backend,
        root: temporaryRoot,
      });
      expect(firstRun.activated.writerGeneration).toBe(1);
      await writeFile(
        path.join(firstRun.activated.grant.root, "state.txt"),
        "durable bytes",
        "utf8",
      );

      // Runtime 进程死亡：Owner 关闭、物理 writer 锁进入隔离态（与 takeover 恢复路径一致）。
      await closeExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        ownershipId: firstRun.acquired.ownership.id,
        state: "lost",
        reasonCode: "runtime_process_lost",
      });
      await revokeWorkspaceWriteLocksForInvocation({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        reasonCode: "runtime_process_lost",
      });
      // 同 Invocation 新 Attempt：同 Host 磁盘与 Workspace 身份不变，恢复取得合法下一代 writer。
      const attempt2 = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        retryReasonCode: "runtime_recovered",
      });
      const evidence = { kind: "workspace-recovery", attemptId: attempt2.id };
      await db.transaction((tx) =>
        markAttemptPreparedInTransaction(tx, {
          attemptId: attempt2.id,
          evidence,
          digest: protocolDigest(evidence),
        }),
      );
      const reacquired = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: attempt2.id,
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      const candidate2 = await prepareWorkspaceCandidate({
        attemptId: attempt2.id,
        binding,
        backend,
        root: temporaryRoot,
        operationId: `continuity-recovery:${attempt2.id}`,
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      if (!candidate2) throw new Error("recovery candidate missing");
      const secondRun = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: attempt2.id,
        ownership: reacquired.ownership,
        authority: reacquired.authority,
        candidate: candidate2,
      });
      expect(secondRun.writerGeneration).toBeGreaterThan(firstRun.activated.writerGeneration);
      expect(secondRun.grant.oldWriterRevoked).toBe(true);
      await expect(stat(path.join(secondRun.grant.root, "state.txt"))).resolves.toBeTruthy();
      await expect(readFile(path.join(secondRun.grant.root, "state.txt"), "utf8")).resolves.toBe(
        "durable bytes",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-02: an unchanged path name with changed disk identity is ContinuityUnproven", () => {
    // 路径名相同但 storageIdentity 改变（换磁盘/重建目录）——空目录不被接受为连续性证明。
    const bindingContract = {
      bindingId: "binding-1",
      continuityMode: "SHARED_DURABLE" as const,
      contractDigest: `sha256:${"0".repeat(64)}`,
      storageScopeDigest: protocolDigest({ scope: "/same/path" }),
      hostIdentity: "host-a",
      storageIdentity: protocolDigest({ storage: "disk-1" }),
      backendKind: "managed_host",
      filesystemSemantics: desktopSemantics,
      checkpointPolicy: null,
    };
    const recomputed = computeWorkspaceContractDigest(bindingContract);
    expectThrownName(
      () =>
        assertWorkspaceContinuity(
          { ...bindingContract, contractDigest: recomputed },
          {
            storageScopeDigest: protocolDigest({ scope: "/same/path" }),
            storageIdentity: protocolDigest({ storage: "disk-2" }),
            hostIdentity: "host-a",
          },
        ),
      "ContinuityUnproven",
    );
    // 完全一致的 storageIdentity 才被接受。
    expect(() =>
      assertWorkspaceContinuity(
        { ...bindingContract, contractDigest: recomputed },
        {
          storageScopeDigest: protocolDigest({ scope: "/same/path" }),
          storageIdentity: protocolDigest({ storage: "disk-1" }),
          hostIdentity: "host-a",
        },
      ),
    ).not.toThrow();
  });

  it("WORKSPACE-03: a permanently lost HOST_AFFINE host fails closed on another host", () => {
    const bindingContract = {
      bindingId: "binding-host-a",
      continuityMode: "HOST_AFFINE" as const,
      contractDigest: "",
      storageScopeDigest: protocolDigest({ scope: "/host-a/workspace" }),
      hostIdentity: "host-a",
      storageIdentity: protocolDigest({ storage: "host-a-disk" }),
      backendKind: "managed_host",
      filesystemSemantics: desktopSemantics,
      checkpointPolicy: null,
    };
    bindingContract.contractDigest = computeWorkspaceContractDigest(bindingContract);
    expectThrownName(
      () =>
        assertWorkspaceContinuity(bindingContract, {
          storageScopeDigest: bindingContract.storageScopeDigest,
          storageIdentity: bindingContract.storageIdentity,
          hostIdentity: "host-b",
        }),
      "ContinuityUnproven",
    );
  });

  it("WORKSPACE-04: two invocations on the same physical scope get exactly one writer regardless of epoch", async () => {
    try {
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
        storageIdentity: protocolDigest({ storage: temporaryRoot }),
        hostIdentity: "continuity-host-a",
      });
      const backend = createWorkspaceBackend(createManagedWorkspaceHost(temporaryRoot));
      const first = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const second = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const firstRun = await prepareAndActivate({
        fixture: first,
        binding,
        backend,
        root: temporaryRoot,
      });
      expect(firstRun.activated.writerGeneration).toBe(1);
      // 不同 Invocation（更高 epoch 语义上互不相干）并发申请同一物理 scope 的 writer。
      await expect(
        reserveWorkspaceWriter({
          tenantId: TENANT_ID,
          storageScopeDigest: protocolDigest({ scope: temporaryRoot }),
          invocationId: second.invocation.id,
          attemptId: second.attempt.id,
          ownershipId: "any-ownership",
          workspaceBindingId: binding.id,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          backendGrantRef: null,
          backendEvidence: { phase: "reserved" },
        }),
      ).rejects.toThrow("Workspace writer 已被其他 Invocation 占用");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-05: two binding aliases of the same root share one physical slot", async () => {
    try {
      const { binding: aliasA } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
        storageIdentity: protocolDigest({ storage: temporaryRoot }),
        hostIdentity: "continuity-host-a",
      });
      const { binding: aliasB } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
        storageIdentity: protocolDigest({ storage: temporaryRoot }),
        hostIdentity: "continuity-host-a",
      });
      const backend = createWorkspaceBackend(createManagedWorkspaceHost(temporaryRoot));
      const fixtureA = await seedPreparedRuntimeAttempt({ workspaceBinding: aliasA });
      const fixtureB = await seedPreparedRuntimeAttempt({ workspaceBinding: aliasB });
      const runA = await prepareAndActivate({
        fixture: fixtureA,
        binding: aliasA,
        backend,
        root: temporaryRoot,
      });
      // 两个 Binding 别名指向同一实际 root → 同 scope slot 约束，不允许双写。
      await expect(
        reserveWorkspaceWriter({
          tenantId: TENANT_ID,
          storageScopeDigest: protocolDigest({ scope: temporaryRoot }),
          invocationId: fixtureB.invocation.id,
          attemptId: fixtureB.attempt.id,
          ownershipId: "alias-b-ownership",
          workspaceBindingId: aliasB.id,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toThrow("Workspace writer 已被其他 Invocation 占用");
      expect(runA.activated.writerGeneration).toBe(1);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-06: a stale shared writer from the old generation cannot write after takeover", async () => {
    try {
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
        storageIdentity: protocolDigest({ storage: temporaryRoot }),
        hostIdentity: "continuity-host-a",
      });
      const backend = createWorkspaceBackend(createManagedWorkspaceHost(temporaryRoot));
      const first = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const firstRun = await prepareAndActivate({
        fixture: first,
        binding,
        backend,
        root: temporaryRoot,
      });
      const oldGrant = firstRun.activated.grant;
      // 换代：旧锁隔离，新 Owner（同 Invocation 新 Attempt 的 takeover）取得下一代。
      await closeExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        ownershipId: firstRun.acquired.ownership.id,
        state: "lost",
        reasonCode: "takeover",
      });
      await revokeWorkspaceWriteLocksForInvocation({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        reasonCode: "takeover",
      });
      const attempt2 = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        retryReasonCode: "takeover",
      });
      const takeoverEvidence = { kind: "workspace-takeover", attemptId: attempt2.id };
      await db.transaction((tx) =>
        markAttemptPreparedInTransaction(tx, {
          attemptId: attempt2.id,
          evidence: takeoverEvidence,
          digest: protocolDigest(takeoverEvidence),
        }),
      );
      const reacquired = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: attempt2.id,
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      const candidate2 = await prepareWorkspaceCandidate({
        attemptId: attempt2.id,
        binding,
        backend,
        root: temporaryRoot,
        operationId: `continuity-takeover:${attempt2.id}`,
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      if (!candidate2) throw new Error("takeover candidate missing");
      const secondRun = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: attempt2.id,
        ownership: reacquired.ownership,
        authority: reacquired.authority,
        candidate: candidate2,
      });
      expect(secondRun.writerGeneration).toBe(oldGrant.writerGeneration + 1);
      // 旧进程仍持旧 grant 尝试写入：host 断言失败，写拒绝，不污染当前 root。
      await expect(backend.host.assertWriter(oldGrant)).rejects.toThrow("WorkspaceWriterNotFenced");
      await writeFile(path.join(secondRun.grant.root, "current.txt"), "new generation", "utf8");
      await expect(readFile(path.join(secondRun.grant.root, "current.txt"), "utf8")).resolves.toBe(
        "new generation",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-07: a reserved DB slot without a fenced backend writer fails closed before running", async () => {
    try {
      const scopeDigest = protocolDigest({ scope: temporaryRoot });
      // Backend 已存在更高的 current writer generation（旧进程未停）。
      const host: WorkspaceHost = createManagedWorkspaceHost(temporaryRoot);
      const backend = createWorkspaceBackend(host);
      const dummyAuthority = {
        invocationId: randomUUID(),
        runtimeRevisionId: randomUUID(),
        attemptId: randomUUID(),
        ownershipId: randomUUID(),
        leaseEpoch: "9",
        sessionBindingId: randomUUID(),
      };
      await backend.host.activateWriter({
        scopeDigest,
        writerGeneration: 2,
        authority: dummyAuthority,
        expectedStorageIdentity: protocolDigest({ storage: temporaryRoot }),
        operationId: "stale-backend",
        root: path.join(temporaryRoot, "old-root"),
      });
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
        storageIdentity: protocolDigest({ storage: temporaryRoot }),
        hostIdentity: "continuity-host-a",
      });
      const fixture = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      // DB 侧 reserve 得到 gen1，但 Host current 已是 gen2：激活必须 fail closed。
      const reserved = await reserveWorkspaceWriter({
        tenantId: TENANT_ID,
        storageScopeDigest: scopeDigest,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        ownershipId: fixture.invocation.id,
        workspaceBindingId: binding.id,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(reserved.writerGeneration).toBe(1);
      await expect(
        backend.host.activateWriter({
          scopeDigest,
          writerGeneration: reserved.writerGeneration,
          authority: {
            ...dummyAuthority,
            invocationId: fixture.invocation.id,
            attemptId: fixture.attempt.id,
          },
          expectedStorageIdentity: protocolDigest({ storage: temporaryRoot }),
          operationId: "fenced-start",
          root: path.join(temporaryRoot, "new-root"),
        }),
      ).rejects.toThrow("WorkspaceWriterNotFenced");
      const [invocation] = await db
        .select()
        .from(invocationTable)
        .where(
          and(
            eq(invocationTable.tenantId, TENANT_ID),
            eq(invocationTable.id, fixture.invocation.id),
          ),
        );
      expect(invocation?.executionState).not.toBe("running");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-08: replaying a lost backend acknowledgement returns the same grant without a new writer", async () => {
    try {
      const scopeDigest = protocolDigest({ scope: temporaryRoot });
      const host = createManagedWorkspaceHost(temporaryRoot);
      const authority = {
        invocationId: randomUUID(),
        runtimeRevisionId: randomUUID(),
        attemptId: randomUUID(),
        ownershipId: randomUUID(),
        leaseEpoch: "1",
        sessionBindingId: randomUUID(),
      };
      const first = await host.activateWriter({
        scopeDigest,
        writerGeneration: 1,
        authority,
        expectedStorageIdentity: protocolDigest({ storage: temporaryRoot }),
        operationId: "replay-check",
        root: temporaryRoot,
      });
      // 回执丢失后以同一 generation 重放操作：同 G 取回同 receipt，不产生新 writer。
      const replayed = await host.activateWriter({
        scopeDigest,
        writerGeneration: 1,
        authority,
        expectedStorageIdentity: protocolDigest({ storage: temporaryRoot }),
        operationId: "replay-check",
        root: temporaryRoot,
      });
      expect(replayed.grantRef).toBe(first.grantRef);
      expect(replayed.writerGeneration).toBe(first.writerGeneration);
      const current = await host.getWriter(scopeDigest, 1);
      expect(current?.grantRef).toBe(first.grantRef);
      const conflicted = host.activateWriter({
        scopeDigest,
        writerGeneration: 1,
        authority: { ...authority, ownershipId: randomUUID() },
        expectedStorageIdentity: protocolDigest({ storage: temporaryRoot }),
        operationId: "replay-check-conflict",
        root: temporaryRoot,
      });
      await expect(conflicted).rejects.toThrow("WorkspaceWriterNotFenced");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-09: failed candidate cleanup removes only the candidate directory", async () => {
    try {
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
        storageIdentity: protocolDigest({ storage: temporaryRoot }),
        hostIdentity: "continuity-host-a",
      });
      const backend = createWorkspaceBackend(createManagedWorkspaceHost(temporaryRoot));
      const owner = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const ownerRun = await prepareAndActivate({
        fixture: owner,
        binding,
        backend,
        root: temporaryRoot,
      });
      await writeFile(path.join(ownerRun.activated.grant.root, "owner.txt"), "owner bytes", "utf8");
      // 另一 Attempt 的 Candidate 准备后失败并清理。
      const other = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const candidate = await prepareWorkspaceCandidate({
        attemptId: other.attempt.id,
        binding,
        backend,
        root: temporaryRoot,
        operationId: `failed-candidate:${other.attempt.id}`,
        runtimeRevisionId: other.binding.runtimeRevisionId,
      });
      if (!candidate) throw new Error("candidate missing");
      await writeFile(
        path.join(candidate.preparation.candidateRoot, "junk.txt"),
        "candidate bytes",
        "utf8",
      );
      await cleanupWorkspaceCandidate(backend.host, candidate.preparation);
      // 只删 Candidate 目录；原 Owner 文件不变。
      await expect(stat(candidate.preparation.candidateRoot)).rejects.toThrow();
      await expect(
        readFile(path.join(ownerRun.activated.grant.root, "owner.txt"), "utf8"),
      ).resolves.toBe("owner bytes");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-10: cleanup resumes idempotently after a crash without touching checkpoint objects", async () => {
    try {
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
        storageIdentity: protocolDigest({ storage: temporaryRoot }),
        hostIdentity: "continuity-host-a",
      });
      const backend = createWorkspaceBackend(createManagedWorkspaceHost(temporaryRoot));
      const fixture = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const candidate = await prepareWorkspaceCandidate({
        attemptId: fixture.attempt.id,
        binding,
        backend,
        root: temporaryRoot,
        operationId: `crash-cleanup:${fixture.attempt.id}`,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
      });
      if (!candidate) throw new Error("candidate missing");
      await writeFile(
        path.join(candidate.preparation.candidateRoot, "half-written.txt"),
        "partial",
        "utf8",
      );
      // 清理到一半 Crash：重启后幂等续做（重复 cleanup 不报错、不删 scope 外对象）。
      await cleanupWorkspaceCandidate(backend.host, candidate.preparation);
      await cleanupWorkspaceCandidate(backend.host, candidate.preparation);
      await expect(stat(candidate.preparation.candidateRoot)).rejects.toThrow();
      // 越权清理（外部目录）必须拒绝，不清理 shared 或 Checkpoint 对象。
      const forged = {
        ...candidate.preparation,
        candidateRoot: path.join(temporaryRoot, "workspace-control"),
      };
      await expect(cleanupWorkspaceCandidate(backend.host, forged)).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-11: readiness evidence cannot be reused across attempts or owners", async () => {
    try {
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
        storageIdentity: protocolDigest({ storage: temporaryRoot }),
        hostIdentity: "continuity-host-a",
      });
      const backend = createWorkspaceBackend(createManagedWorkspaceHost(temporaryRoot));
      const fixture = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const run = await prepareAndActivate({ fixture, binding, backend, root: temporaryRoot });
      await db
        .update(executionOwnershipTable)
        .set({
          workspaceWriterGeneration: run.activated.writerGeneration,
          updatedAt: new Date(),
        })
        .where(eq(executionOwnershipTable.id, run.acquired.ownership.id));
      // A1 的 readiness 证据合法。
      await expect(
        requireWorkspaceReadiness({
          tenantId: TENANT_ID,
          invocationId: fixture.invocation.id,
          ownershipId: run.acquired.ownership.id,
          workspaceBindingId: binding.id,
          expectedWriterGeneration: run.activated.writerGeneration,
        }),
      ).resolves.toMatchObject({
        bindingId: binding.id,
        writerGeneration: run.activated.writerGeneration,
      });
      // A2 / 陌生 Owner 不能采用同一证明。
      await expect(
        requireWorkspaceReadiness({
          tenantId: TENANT_ID,
          invocationId: fixture.invocation.id,
          ownershipId: "not-the-owner",
          workspaceBindingId: binding.id,
        }),
      ).rejects.toThrow("NotCurrentExecutor");
      await expect(
        requireWorkspaceReadiness({
          tenantId: TENANT_ID,
          invocationId: fixture.invocation.id,
          ownershipId: run.acquired.ownership.id,
          workspaceBindingId: binding.id,
          expectedWriterGeneration: run.activated.writerGeneration + 7,
        }),
      ).rejects.toThrow("WorkspaceWriterNotFenced");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-12: a desktop HOST_AFFINE binding refuses a same-path mount from another device", async () => {
    const user = await upsertUserIdentity({
      tenantId: TENANT_ID,
      externalSubject: `workspace-continuity-${randomUUID()}`,
      email: "continuity@example.com",
      displayName: "Continuity User",
    });
    const deviceA = await registerDevice({
      tenantId: TENANT_ID,
      userId: user.id,
      deviceKey: `device-a-${randomUUID()}`,
      publicKey: "test-public-key",
      deviceName: "Device A",
      appVersion: "test",
    });
    const deviceB = await registerDevice({
      tenantId: TENANT_ID,
      userId: user.id,
      deviceKey: `device-b-${randomUUID()}`,
      publicKey: "test-public-key",
      deviceName: "Device B",
      appVersion: "test",
    });
    const { binding } = await createTestBinding({
      root: temporaryRoot,
      continuityMode: "HOST_AFFINE",
      storageIdentity: protocolDigest({ storage: temporaryRoot }),
      hostIdentity: deviceA.id,
      bindingType: "desktop",
      deviceId: deviceA.id,
    });
    const contract = {
      bindingId: binding.id,
      continuityMode: binding.continuityMode as "HOST_AFFINE",
      contractDigest: binding.contractDigest,
      storageScopeDigest: binding.storageScopeDigest,
      hostIdentity: binding.hostIdentity,
      storageIdentity: binding.storageIdentity,
      backendKind: binding.backendKind,
      filesystemSemantics: desktopSemantics,
      checkpointPolicy: null,
    };
    // deviceA 上同一身份：接受。
    expect(() =>
      assertWorkspaceContinuity(contract, {
        storageScopeDigest: binding.storageScopeDigest,
        storageIdentity: binding.storageIdentity,
        hostIdentity: deviceA.id,
      }),
    ).not.toThrow();
    // deviceB 挂同名路径：hostIdentity 不同 → 拒绝跨设备暗迁。
    expectThrownName(
      () =>
        assertWorkspaceContinuity(contract, {
          storageScopeDigest: binding.storageScopeDigest,
          storageIdentity: binding.storageIdentity,
          hostIdentity: deviceB.id,
        }),
      "ContinuityUnproven",
    );
  });
});
