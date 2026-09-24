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
  attemptPreparationClaimForTest,
  markAttemptPreparedForTestInTransaction,
} from "@/lib/executions/test-support/preparation-fixtures";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { registerDevice } from "@/lib/identity/device-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { executionOwnershipTable, invocationTable } from "@/lib/persistence/schema/executions";
import { workspaceWriteLock } from "@/lib/persistence/schema/workspace-lock";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { getRuntimeSessionBindingsByInvocation } from "@/lib/runtime/persistence/runtime-session-store";
import { createHttpRuntimeClient, createMockRuntimeClient } from "@/lib/runtime/runtime-client";
import { PROTOCOL_VERSION, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { type WorkspaceBackend, createWorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { cleanupWorkspaceCandidate } from "@/lib/workspace/workspace-cleanup";
import {
  assertWorkspaceContinuity,
  computeWorkspaceContractDigest,
} from "@/lib/workspace/workspace-contract";
import { type WorkspaceHost, createManagedWorkspaceHost } from "@/lib/workspace/workspace-host";
import {
  WorkspaceIdentityMismatchError,
  continuousWriterArgs,
  createRemoteWorkspaceHost,
  createWorkspaceHostBroker,
  listenWorkspaceHostRpc,
} from "@/lib/workspace/workspace-host-server";
import { createWorkspace, createWorkspaceBinding } from "@/lib/workspace/workspace-queries";
import { requireWorkspaceReadiness } from "@/lib/workspace/workspace-readiness";
import { reserveWorkspaceWriter } from "@/lib/workspace/workspace-write-lock-queries";
import {
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
} from "@/lib/workspace/workspace-writer";
import { runWorkspaceWriterRelease } from "@/lib/workspace/workspace-writer-release";
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
  /** 显式传入时表示纯函数场景（不做 Writer 激活）；否则用受管 Broker 的真实探测结果。 */
  storageIdentity?: string;
  hostIdentity?: string;
  brokerHostIdentity?: string;
  bindingType?: "desktop" | "cloud" | "remote" | "sandbox";
  deviceId?: string | null;
}) {
  const probe =
    input.storageIdentity && input.hostIdentity
      ? null
      : await createWorkspaceHostBroker({
          root: input.root,
          hostIdentity: input.brokerHostIdentity,
        }).probeIdentity();
  const storageIdentity = input.storageIdentity ?? probe?.storageIdentity ?? "";
  const hostIdentity = input.hostIdentity ?? probe?.hostIdentity ?? "";
  const logical = await createWorkspace({
    tenantId: TENANT_ID,
    workspaceKey: `continuity-${randomUUID()}`,
    displayName: "Continuity fixture",
  });
  // 物理 scope 由 Broker 按实际 root + 存储身份 + Host 身份派生，不信任提交的字符串。
  const storageScopeDigest = probe ? probe.scopeDigest : protocolDigest({ scope: input.root });
  const binding = await createWorkspaceBinding({
    tenantId: TENANT_ID,
    workspaceId: logical.id,
    continuityMode: input.continuityMode,
    bindingType: input.bindingType ?? "sandbox",
    deviceId: input.deviceId ?? null,
    locationRef: `managed://continuity-${randomUUID()}`,
    storageScopeDigest,
    backendKind: "managed_host",
    hostIdentity,
    storageIdentity,
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
      hostIdentity,
      storageIdentity,
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
      });
      const broker = createWorkspaceHostBroker({ root: temporaryRoot });
      const backend = createWorkspaceBackend(broker);
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
      const activityFile = path.join(firstRun.activated.grant.root, "runtime-activity.txt");
      const runtime = await broker.spawnManagedWriter({
        tenantId: TENANT_ID,
        scopeDigest: firstRun.activated.grant.scopeDigest,
        writerGeneration: firstRun.activated.writerGeneration,
        command: process.execPath,
        args: continuousWriterArgs({ targetFile: activityFile, payload: "runtime-active" }),
        cwd: firstRun.activated.grant.root,
        activityPath: activityFile,
      });
      const activityDeadline = Date.now() + 8_000;
      while (Date.now() < activityDeadline) {
        if ((await stat(activityFile).catch(() => null))?.size) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await stat(activityFile)).size).toBeGreaterThan(0);
      process.kill(runtime.pid, "SIGKILL");

      // Runtime 进程真实退出后，Owner 关闭才成为持久事实（R04 §3：I 侧不释放 W 行）。
      // 接管必须仅凭"父 Owner 已失权 + W 路径复核"成立，不依赖任何显式撤销调用。
      await closeExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        ownershipId: firstRun.acquired.ownership.id,
        state: "lost",
        reasonCode: "runtime_process_lost",
      });
      // A07 决策四：父 Owner 失权只解除"逻辑当前"，**不等于**旧 Writer 已经停下。
      // `active` 行必须由持久释放 lane 拿到真实停止回执、写成 `released` 之后，下一代才可分配
      // —— 否则旧 Writer 会失去定位。这仍然是 lane 的自主行为，不是 I 侧显式撤销 W 行。
      const recoveredRelease = await runWorkspaceWriterRelease({
        tenantId: TENANT_ID,
        lockId: firstRun.activated.lockId,
        leaseOwner: "continuity-release",
        deps: { resolveHost: async () => backend.host },
      });
      expect(recoveredRelease.outcome).toBe("released");
      // 同 Invocation 新 Attempt：同 Host 磁盘与 Workspace 身份不变，恢复取得合法下一代 writer。
      const attempt2 = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        retryReasonCode: "runtime_recovered",
      });
      const evidence = { kind: "workspace-recovery", attemptId: attempt2.id };
      await db.transaction((tx) =>
        markAttemptPreparedForTestInTransaction(tx, {
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
    const servers = [
      await listenWorkspaceHostRpc({ broker: createWorkspaceHostBroker({ root: temporaryRoot }) }),
      await listenWorkspaceHostRpc({ broker: createWorkspaceHostBroker({ root: temporaryRoot }) }),
    ];
    try {
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
      });
      const first = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const second = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const firstAuthority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: first.attempt.id,
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      const secondFirstAuthority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: second.invocation.id,
        attemptId: second.attempt.id,
        runtimeRevisionId: second.binding.runtimeRevisionId,
      });
      await closeExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: second.invocation.id,
        ownershipId: secondFirstAuthority.ownership.id,
        state: "lost",
        reasonCode: "test_next_epoch",
      });
      const secondAttempt = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: second.invocation.id,
        retryReasonCode: "test_next_epoch",
      });
      const secondEvidence = { kind: "workspace-race", attemptId: secondAttempt.id };
      await db.transaction((tx) =>
        markAttemptPreparedForTestInTransaction(tx, {
          attemptId: secondAttempt.id,
          evidence: secondEvidence,
          digest: protocolDigest(secondEvidence),
        }),
      );
      const secondAuthority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: second.invocation.id,
        attemptId: secondAttempt.id,
        runtimeRevisionId: second.binding.runtimeRevisionId,
      });
      expect(firstAuthority.ownership.leaseEpoch).not.toBe(secondAuthority.ownership.leaseEpoch);
      const backends = servers.map((server) =>
        createWorkspaceBackend(createRemoteWorkspaceHost(server.url)),
      );
      const candidates = await Promise.all([
        prepareWorkspaceCandidate({
          attemptId: first.attempt.id,
          binding,
          backend: backends[0]!,
          root: temporaryRoot,
          operationId: `workspace-race:${first.attempt.id}`,
          runtimeRevisionId: first.binding.runtimeRevisionId,
        }),
        prepareWorkspaceCandidate({
          attemptId: secondAttempt.id,
          binding,
          backend: backends[1]!,
          root: temporaryRoot,
          operationId: `workspace-race:${secondAttempt.id}`,
          runtimeRevisionId: second.binding.runtimeRevisionId,
        }),
      ]);
      if (!candidates[0] || !candidates[1]) throw new Error("race candidates missing");
      const results = await Promise.allSettled([
        activatePreparedWorkspaceWriter({
          tenantId: TENANT_ID,
          invocationId: first.invocation.id,
          attemptId: first.attempt.id,
          ownership: firstAuthority.ownership,
          authority: firstAuthority.authority,
          candidate: candidates[0],
        }),
        activatePreparedWorkspaceWriter({
          tenantId: TENANT_ID,
          invocationId: second.invocation.id,
          attemptId: secondAttempt.id,
          ownership: secondAuthority.ownership,
          authority: secondAuthority.authority,
          candidate: candidates[1],
        }),
      ]);
      const winner = results.find((result) => result.status === "fulfilled");
      const loser = results.find((result) => result.status === "rejected");
      expect(winner?.status).toBe("fulfilled");
      expect(loser?.status).toBe("rejected");
      if (loser?.status !== "rejected") throw new Error("workspace writer race had no loser");
      expect((loser.reason as Error).message).toContain("父 Owner 仍然健康");
      const active = await db
        .select()
        .from(workspaceWriteLock)
        .where(eq(workspaceWriteLock.storageScopeDigest, binding.storageScopeDigest as string));
      expect(active.filter((lock) => lock.lockState === "active")).toHaveLength(1);
      if (winner?.status !== "fulfilled") throw new Error("workspace writer race had no winner");
      const physical = await backends[0]!.host.getWriter(
        binding.storageScopeDigest as string,
        winner.value.writerGeneration,
      );
      expect(physical?.grantRef).toBe(winner.value.grant.grantRef);
      await backends[1]!.host.assertWriter(winner.value.grant);
    } finally {
      for (const server of servers) await server.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("WORKSPACE-05: two binding aliases of the same root share one physical slot", async () => {
    try {
      const { binding: aliasA } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
      });
      const { binding: aliasB } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
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
          storageScopeDigest: aliasA.storageScopeDigest as string,
          invocationId: fixtureB.invocation.id,
          attemptId: fixtureB.attempt.id,
          ownershipId: "alias-b-ownership",
          workspaceBindingId: aliasB.id,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toThrow("父 Owner 仍然健康");
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
      // 换代：旧 Owner 失权即为持久事实；但新 Owner 仍须等旧 Writer 被**真实停止**后才能
      // 取得下一代（A07 决策四）—— 这一步由持久释放 lane 完成，不需要 I 侧显式撤销 W 行。
      await closeExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        ownershipId: firstRun.acquired.ownership.id,
        state: "lost",
        reasonCode: "takeover",
      });
      const takeoverRelease = await runWorkspaceWriterRelease({
        tenantId: TENANT_ID,
        lockId: firstRun.activated.lockId,
        leaseOwner: "continuity-takeover-release",
        deps: { resolveHost: async () => backend.host },
      });
      expect(takeoverRelease.outcome).toBe("released");
      const attempt2 = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        retryReasonCode: "takeover",
      });
      const takeoverEvidence = { kind: "workspace-takeover", attemptId: attempt2.id };
      await db.transaction((tx) =>
        markAttemptPreparedForTestInTransaction(tx, {
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
      // 旧进程持旧授权经正式受管写入口执行实际 IO，必须在写入前拒绝。
      await expect(backend.host.assertWriter(oldGrant)).rejects.toThrow("WorkspaceWriterNotFenced");
      await expect(
        backend.host.executeManagedFileOperation({
          identity: {
            tenantId: TENANT_ID,
            scopeDigest: oldGrant.scopeDigest,
            writerGeneration: oldGrant.writerGeneration,
            invocationId: oldGrant.invocationId,
            attemptId: oldGrant.attemptId,
            ownershipId: oldGrant.ownershipId,
            operationId: oldGrant.operationId,
          },
          operation: { kind: "write", path: "stale.txt", content: "old generation" },
        }),
      ).rejects.toThrow("WorkspaceWriterNotFenced");
      await expect(stat(path.join(secondRun.grant.root, "stale.txt"))).rejects.toThrow();
      await writeFile(path.join(secondRun.grant.root, "current.txt"), "new generation", "utf8");
      await expect(readFile(path.join(secondRun.grant.root, "current.txt"), "utf8")).resolves.toBe(
        "new generation",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-07: a reserved DB slot without a fenced backend writer fails closed before running", async () => {
    let oldPid: number | null = null;
    try {
      const broker = createWorkspaceHostBroker({ root: temporaryRoot });
      const probe = await broker.probeIdentity();
      const scopeDigest = probe.scopeDigest;
      // Backend 已存在更高的 current writer generation，且受管进程真实存活、持续写盘。
      const backend = createWorkspaceBackend(broker);
      const dummyAuthority = {
        invocationId: randomUUID(),
        runtimeRevisionId: randomUUID(),
        attemptId: randomUUID(),
        ownershipId: randomUUID(),
        leaseEpoch: "9",
        sessionBindingId: randomUUID(),
      };
      await backend.host.activateWriter({
        tenantId: TENANT_ID,
        scopeDigest,
        writerGeneration: 2,
        authority: dummyAuthority,
        expectedStorageIdentity: probe.storageIdentity,
        operationId: "stale-backend",
        root: path.join(temporaryRoot, "old-root"),
      });
      const activityFile = path.join(temporaryRoot, "old-writer-activity.txt");
      const oldWriter = await broker.spawnManagedWriter({
        tenantId: TENANT_ID,
        scopeDigest,
        writerGeneration: 2,
        command: process.execPath,
        args: continuousWriterArgs({ targetFile: activityFile, payload: "old-writer" }),
        cwd: temporaryRoot,
        activityPath: activityFile,
      });
      oldPid = oldWriter.pid;
      process.kill(oldWriter.pid, 0);
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
      });
      const fixture = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const startAttempt = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
      });
      // 正式 Start 自己预留 DB gen1，再请求物理激活；不能由测试直接调用 Backend 代替 Start。
      await expect(
        startRuntimeInvocation({
          tenantId: TENANT_ID,
          invocation: fixture.invocation,
          binding: fixture.binding,
          attempt: startAttempt,
          sourceOperationKey: `invocation:${fixture.invocation.id}`,
          runtimeClient: createHttpRuntimeClient(),
          runtimeEndpoint: "http://127.0.0.1:1",
          auth: { mode: "none" },
          callbackEndpoints: {
            events: "http://127.0.0.1:1/runtime/events",
            heartbeat: "http://127.0.0.1:1/runtime/heartbeat",
            context: "http://127.0.0.1:1/gateway/context",
            capabilityActions: "http://127.0.0.1:1/gateway/capability-actions",
            toolCalls: "http://127.0.0.1:1/gateway/tool-calls",
            userActions: "http://127.0.0.1:1/gateway/user-actions",
          },
          workspace: {
            binding,
            backend,
            root: temporaryRoot,
            snapshotStorage: { kind: "broker_default" },
          },
        }),
      ).rejects.toThrow("WorkspaceWriterNotFenced");
      const locks = await db
        .select()
        .from(workspaceWriteLock)
        .where(eq(workspaceWriteLock.storageScopeDigest, scopeDigest));
      expect(locks.some((lock) => lock.writerGeneration === 1)).toBe(true);
      process.kill(oldWriter.pid, 0);
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
      if (oldPid !== null) {
        try {
          process.kill(oldPid, "SIGKILL");
        } catch {
          // Broker 已确认旧进程退出时无需重复发送信号。
        }
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("WORKSPACE-08: replaying a lost backend acknowledgement returns the same grant without a new writer", async () => {
    try {
      const broker = createWorkspaceHostBroker({ root: temporaryRoot });
      const probe = await broker.probeIdentity();
      const scopeDigest = probe.scopeDigest;
      const host = broker;
      const authority = {
        invocationId: randomUUID(),
        runtimeRevisionId: randomUUID(),
        attemptId: randomUUID(),
        ownershipId: randomUUID(),
        leaseEpoch: "1",
        sessionBindingId: randomUUID(),
      };
      const first = await host.activateWriter({
        tenantId: TENANT_ID,
        scopeDigest,
        writerGeneration: 1,
        authority,
        expectedStorageIdentity: probe.storageIdentity,
        operationId: "replay-check",
        root: temporaryRoot,
      });
      // 回执丢失后以同一 generation 重放操作：同 G 取回同 receipt，不产生新 writer。
      const replayed = await host.activateWriter({
        tenantId: TENANT_ID,
        scopeDigest,
        writerGeneration: 1,
        authority,
        expectedStorageIdentity: probe.storageIdentity,
        operationId: "replay-check",
        root: temporaryRoot,
      });
      expect(replayed.grantRef).toBe(first.grantRef);
      expect(replayed.writerGeneration).toBe(first.writerGeneration);
      const current = await host.getWriter(scopeDigest, 1);
      expect(current?.grantRef).toBe(first.grantRef);
      const conflicted = host.activateWriter({
        tenantId: TENANT_ID,
        scopeDigest,
        writerGeneration: 1,
        authority: { ...authority, ownershipId: randomUUID() },
        expectedStorageIdentity: probe.storageIdentity,
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
      });
      const backend = createWorkspaceBackend(createManagedWorkspaceHost(temporaryRoot));
      const fixture = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const run = await prepareAndActivate({ fixture, binding, backend, root: temporaryRoot });
      // 正式激活会同时冻结 activationEvidence/Digest；这里按同一形状补齐，readiness 才能核验。
      const readinessEvidence = {
        kind: "execution-activated",
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        ownershipId: run.acquired.ownership.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        workspace: {
          mode: binding.continuityMode,
          lockId: run.activated.lockId,
          writerGeneration: run.activated.writerGeneration,
          grantRef: run.activated.grant.grantRef,
          backendEvidence: run.activated.grant.backendEvidence,
        },
      };
      await db
        .update(executionOwnershipTable)
        .set({
          workspaceWriterGeneration: run.activated.writerGeneration,
          activationEvidence: readinessEvidence,
          activationDigest: protocolDigest(readinessEvidence),
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
          backend: backend.host,
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
          backend: backend.host,
        }),
      ).rejects.toThrow("NotCurrentExecutor");
      await expect(
        requireWorkspaceReadiness({
          tenantId: TENANT_ID,
          invocationId: fixture.invocation.id,
          ownershipId: run.acquired.ownership.id,
          workspaceBindingId: binding.id,
          expectedWriterGeneration: run.activated.writerGeneration + 7,
          backend: backend.host,
        }),
      ).rejects.toThrow("WorkspaceWriterNotFenced");
      await closeExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        ownershipId: run.acquired.ownership.id,
        state: "lost",
        reasonCode: "workspace_readiness_next_attempt",
      });
      const released = await runWorkspaceWriterRelease({
        tenantId: TENANT_ID,
        lockId: run.activated.lockId,
        leaseOwner: "workspace-readiness-release",
        deps: { resolveHost: async () => backend.host },
      });
      expect(released.outcome).toBe("released");
      const nextAttempt = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        retryReasonCode: "workspace_readiness_next_attempt",
      });
      const nextEvidence = { kind: "workspace-readiness", attemptId: nextAttempt.id };
      await db.transaction((tx) =>
        markAttemptPreparedForTestInTransaction(tx, {
          attemptId: nextAttempt.id,
          evidence: nextEvidence,
          digest: protocolDigest(nextEvidence),
        }),
      );
      const nextAuthority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        attemptId: nextAttempt.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
      });
      expect(nextAuthority.ownership.attemptId).toBe(nextAttempt.id);
      await expect(
        requireWorkspaceReadiness({
          tenantId: TENANT_ID,
          invocationId: fixture.invocation.id,
          ownershipId: nextAuthority.ownership.id,
          workspaceBindingId: binding.id,
          expectedWriterGeneration: run.activated.writerGeneration,
          backend: backend.host,
        }),
      ).rejects.toThrow("WorkspaceNotReady");
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
      brokerHostIdentity: deviceA.id,
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
    const deviceBHost = createWorkspaceHostBroker({
      root: temporaryRoot,
      hostIdentity: deviceB.id,
    });
    await expect(deviceBHost.probeIdentity()).rejects.toBeInstanceOf(
      WorkspaceIdentityMismatchError,
    );
    await expect(
      deviceBHost.activateWriter({
        tenantId: TENANT_ID,
        scopeDigest: binding.storageScopeDigest as string,
        writerGeneration: 1,
        authority: {
          invocationId: randomUUID(),
          runtimeRevisionId: randomUUID(),
          attemptId: randomUUID(),
          ownershipId: randomUUID(),
          leaseEpoch: "1",
          sessionBindingId: randomUUID(),
        },
        expectedStorageIdentity: binding.storageIdentity as string,
        operationId: `device-b:${randomUUID()}`,
        root: temporaryRoot,
      }),
    ).rejects.toBeInstanceOf(WorkspaceIdentityMismatchError);
  });

  it("N05-T4: 同源激活的迟到错误不关闭已运行 Owner 与真实 Writer", async () => {
    try {
      const { binding } = await createTestBinding({
        root: temporaryRoot,
        continuityMode: "SHARED_DURABLE",
      });
      const broker = createWorkspaceHostBroker({ root: temporaryRoot });
      const fixture = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const attempt = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
      });
      const revision = await getRuntimeRevisionById(fixture.binding.runtimeRevisionId);
      if (!revision) throw new Error("RuntimeRevision 缺失");
      const capabilitiesDigest = expectedCapabilityManifestDigest({
        runtimeRevisionId: revision.id,
        runtimeCapabilitiesJson: revision.runtimeCapabilitiesJson,
      });
      let releaseOld!: () => void;
      const holdOld = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      let reached!: () => void;
      const oldReached = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const delayedHost: WorkspaceHost = new Proxy(broker, {
        get(target, property, receiver) {
          if (property === "activateWriter")
            return async () => {
              reached();
              await holdOld;
              throw new Error("ordinary delayed activation error");
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const runtimeClient = createMockRuntimeClient({
        async startInvocation({ request }) {
          const remoteSessionRef = `n05-session:${request.authority.ownershipId}`;
          const remoteExecutionRef = `n05-execution:${request.authority.ownershipId}`;
          await ingressRuntimeEvents({
            tenantId: TENANT_ID,
            invocationId: fixture.invocation.id,
            batch: {
              protocolVersion: PROTOCOL_VERSION,
              authority: request.authority,
              events: [
                {
                  eventId: randomUUID(),
                  producerSequence: request.producerSequenceStart,
                  type: "execution.started",
                  schemaVersion: 1,
                  payload: {
                    intentKey: `start:${request.authority.ownershipId}`,
                    semanticRequestDigest: request.semanticRequestDigest,
                    remoteSessionRef,
                    remoteExecutionRef,
                    capabilitiesDigest,
                  },
                },
              ],
            },
          });
          return {
            protocolVersion: PROTOCOL_VERSION,
            authority: request.authority,
            semanticRequestDigest: request.semanticRequestDigest,
            accepted: true,
            remoteSessionRef,
            remoteExecutionRef,
            capabilitiesDigest,
            acceptedAt: Date.now(),
          };
        },
      });
      const start = (
        host: WorkspaceHost,
        preparationClaim?: Awaited<ReturnType<typeof attemptPreparationClaimForTest>>,
      ) =>
        startRuntimeInvocation({
          tenantId: TENANT_ID,
          invocation: fixture.invocation,
          binding: fixture.binding,
          attempt,
          sourceOperationKey: `invocation:${fixture.invocation.id}`,
          ...(preparationClaim ? { preparationClaim } : {}),
          runtimeClient,
          runtimeEndpoint: "https://runtime.example.invalid",
          auth: { mode: "none" },
          callbackEndpoints: {
            events: "https://runtime.example.invalid/events",
            heartbeat: "https://runtime.example.invalid/heartbeat",
            context: "https://runtime.example.invalid/context",
            capabilityActions: "https://runtime.example.invalid/capability-actions",
            toolCalls: "https://runtime.example.invalid/tool-calls",
            userActions: "https://runtime.example.invalid/user-actions",
          },
          workspace: {
            binding,
            backend: createWorkspaceBackend(host),
            root: temporaryRoot,
            snapshotStorage: { kind: "broker_default" },
          },
        });
      const first = start(delayedHost);
      try {
        await oldReached;
        const second = await start(broker, await attemptPreparationClaimForTest(attempt.id));
        const current = await getActiveExecutionOwnership({
          tenantId: TENANT_ID,
          invocationId: fixture.invocation.id,
        });
        expect(current?.id).toBe(second.authority.ownershipId);
        expect(current?.executionPhase).toBe("executing");
        releaseOld();
        await expect(first).rejects.toThrow("ordinary delayed activation error");
        const after = await getActiveExecutionOwnership({
          tenantId: TENANT_ID,
          invocationId: fixture.invocation.id,
        });
        expect(after?.id).toBe(current?.id);
        expect(after?.executionPhase).toBe("executing");
        expect(
          await getRuntimeSessionBindingsByInvocation(TENANT_ID, fixture.invocation.id),
        ).toHaveLength(1);
        const [lock] = await db
          .select()
          .from(workspaceWriteLock)
          .where(eq(workspaceWriteLock.holderOwnershipId, current!.id));
        expect(lock?.lockState).toBe("active");
        const grant = await broker.getWriter(
          binding.storageScopeDigest as string,
          lock!.writerGeneration,
        );
        expect(grant).not.toBeNull();
        if (grant) await broker.assertWriter(grant);
      } finally {
        releaseOld();
        await first.catch(() => undefined);
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
