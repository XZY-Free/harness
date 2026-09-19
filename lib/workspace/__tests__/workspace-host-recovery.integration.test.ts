/**
 * 受管 WorkspaceHost 的真实 Writer 保证（R08 · WRITER-01..08）。
 *
 * 本套件的每个用例都要求**真实进程 / 真实磁盘身份 / 真实跨进程 CAS**：
 * - 旧 Writer 是真实子进程（自己写文件），换代时由 Broker 终止其进程组并确认退出；
 * - 存储身份来自真实 `stat`（dev/inode），不是调用方提交的字符串；
 * - 跨客户端并发使用两个独立 Broker RPC 服务（各自的 Broker 实例）经真实 HTTP 竞争。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { closeExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { registerDevice } from "@/lib/identity/device-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { workspaceWriteLock } from "@/lib/persistence/schema/workspace-lock";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { type WorkspaceBackend, createWorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { computeWorkspaceContractDigest } from "@/lib/workspace/workspace-contract";
import {
  WorkspaceCleanupRejectedError,
  type WorkspaceHostIdentityProbe,
  WorkspaceIdentityMismatchError,
  WorkspaceWriterNotFencedError,
  type WriterStopEvidence,
  continuousWriterArgs,
  createRemoteWorkspaceHost,
  createWorkspaceHostBroker,
  listenWorkspaceHostRpc,
} from "@/lib/workspace/workspace-host-server";
import { createWorkspace, createWorkspaceBinding } from "@/lib/workspace/workspace-queries";
import {
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
} from "@/lib/workspace/workspace-writer";
import { runWorkspaceWriterRelease } from "@/lib/workspace/workspace-writer-release";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";

const filesystemSemantics = {
  kind: "desktop",
  caseSensitive: true,
  symlinks: true,
  permissions: true,
  hardlinks: true,
  specialFiles: false,
  xattrsAcl: true,
  mtime: "preserved",
} as const;

/** 进程是否存活（真实 signal 0 探测）。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function fileSize(target: string): Promise<number> {
  try {
    return (await stat(target)).size;
  } catch {
    return -1;
  }
}

async function waitForGrowth(target: string, minimumBytes: number, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const size = await fileSize(target);
    if (size >= minimumBytes) return size;
    last = size;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`受管 Writer 未产生预期写入：size=${last}`);
}

let sequence = 0;
/** 稳定但不重复的 scope 内 generation 名称。 */
function nextOperationId(prefix: string): string {
  sequence += 1;
  return `${prefix}:${sequence}:${randomUUID()}`;
}

async function createBindingAtRoot(input: {
  root: string;
  probe: WorkspaceHostIdentityProbe;
  continuityMode: "HOST_AFFINE" | "SHARED_DURABLE";
  deviceId?: string | null;
}) {
  const logical = await createWorkspace({
    tenantId: TENANT_ID,
    workspaceKey: `host-recovery-${randomUUID()}`,
    displayName: "Host recovery fixture",
  });
  const contractDigest = computeWorkspaceContractDigest({
    bindingId: "fixture",
    continuityMode: input.continuityMode,
    storageScopeDigest: input.probe.scopeDigest,
    hostIdentity: input.probe.hostIdentity,
    storageIdentity: input.probe.storageIdentity,
    backendKind: "managed_host",
    filesystemSemantics,
    checkpointPolicy: null,
  });
  const binding = await createWorkspaceBinding({
    tenantId: TENANT_ID,
    workspaceId: logical.id,
    continuityMode: input.continuityMode,
    bindingType: input.deviceId ? "desktop" : "sandbox",
    deviceId: input.deviceId ?? null,
    locationRef: `managed://${randomUUID()}`,
    storageScopeDigest: input.probe.scopeDigest,
    backendKind: "managed_host",
    hostIdentity: input.probe.hostIdentity,
    storageIdentity: input.probe.storageIdentity,
    accessMode: "read_write",
    filesystemSemantics,
    checkpointPolicy: null,
    contractDigest,
    createdBy: "test-service",
  });
  return binding;
}

describe("Workspace host recovery integration", () => {
  let root = "";
  let backend: WorkspaceBackend;

  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
    root = await mkdtemp(path.join(tmpdir(), "snowharness-host-recovery-"));
    backend = createWorkspaceBackend(createWorkspaceHostBroker({ root }));
  });

  it("WRITER-01: a running managed writer process group is really stopped and drained on takeover", async () => {
    try {
      const broker = createWorkspaceHostBroker({ root });
      const probe = await broker.probeIdentity();
      const binding = await createBindingAtRoot({ root, probe, continuityMode: "SHARED_DURABLE" });
      const first = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const firstAuthority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: first.attempt.id,
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      const firstCandidate = await prepareWorkspaceCandidate({
        attemptId: first.attempt.id,
        binding,
        backend,
        root,
        operationId: nextOperationId("gen1"),
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      if (!firstCandidate) throw new Error("candidate missing");
      const generation1 = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: first.attempt.id,
        ownership: firstAuthority.ownership,
        authority: firstAuthority.authority,
        candidate: firstCandidate,
      });

      // 真实旧 Writer：一个持续写当前根的受管子进程（进程组 leader）。
      const activityFile = path.join(root, "writer-activity.log");
      const spawned = await broker.spawnManagedWriter({
        tenantId: TENANT_ID,
        scopeDigest: probe.scopeDigest,
        writerGeneration: generation1.writerGeneration,
        command: process.execPath,
        args: continuousWriterArgs({ targetFile: activityFile, payload: "old-writer" }),
        cwd: root,
        activityPath: activityFile,
      });
      expect(processAlive(spawned.pid)).toBe(true);
      await waitForGrowth(activityFile, 64);

      // 换代：Owner 失联即为持久事实（R04 §3：I 侧不释放 W 行）→ 新 Attempt 取得下一代。
      await closeExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        ownershipId: firstAuthority.ownership.id,
        state: "lost",
        reasonCode: "runtime_process_lost",
      });
      // A07 决策四：失权只解除"逻辑当前"，`active` 行必须由持久释放 lane 拿真实停止回执
      // 写成 `released` 之后，下一代才被分配 —— 停机与排空证据从此处产生，而不是在激活里。
      const stoppedByLane = await runWorkspaceWriterRelease({
        tenantId: TENANT_ID,
        lockId: generation1.lockId,
        leaseOwner: "writer-01-release",
        deps: { resolveHost: async () => backend.host },
      });
      expect(stoppedByLane.outcome).toBe("released");
      const stoppedRow = await readLock(generation1.lockId);
      expect(stoppedRow.lockState).toBe("released");
      const receipt = stoppedRow.releaseReceipt as WriterStopEvidence;
      // 真实停止证据：旧进程已退出，进程组为空，信号是真实发出的。
      expect(receipt.previousWriterPresent).toBe(true);
      expect(receipt.stopped).toBe(true);
      expect(receipt.processGroupEmpty).toBe(true);
      expect(receipt.pids).toContain(spawned.pid);
      expect(receipt.signals).toContain("SIGTERM");
      expect(processAlive(spawned.pid)).toBe(false);

      // 排空：旧写入停止后当前根不再有新写入（换代前就已确认，而不是靠新激活顺带确认）。
      const sizeAfterStop = await fileSize(activityFile);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await fileSize(activityFile)).toBe(sizeAfterStop);

      const attempt2 = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        retryReasonCode: "runtime_recovered",
      });
      const attempt2Evidence = { kind: "workspace-recovery", attemptId: attempt2.id };
      await db.transaction((tx) =>
        markAttemptPreparedInTransaction(tx, {
          attemptId: attempt2.id,
          evidence: attempt2Evidence,
          digest: protocolDigest(attempt2Evidence),
        }),
      );
      const secondAuthority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: attempt2.id,
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      const secondCandidate = await prepareWorkspaceCandidate({
        attemptId: attempt2.id,
        binding,
        backend,
        root,
        operationId: nextOperationId("gen2"),
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      if (!secondCandidate) throw new Error("recovery candidate missing");
      const generation2 = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: attempt2.id,
        ownership: secondAuthority.ownership,
        authority: secondAuthority.authority,
        candidate: secondCandidate,
      });
      expect(generation2.writerGeneration).toBeGreaterThan(generation1.writerGeneration);
      expect(processAlive(spawned.pid)).toBe(false);

      // 新 generation 正常写当前根，旧内容保持可读且不混杂。
      await writeFile(path.join(root, "gen2.txt"), "new generation", "utf8");
      await expect(readFile(path.join(root, "gen2.txt"), "utf8")).resolves.toBe("new generation");
      await expect(readFile(activityFile, "utf8")).resolves.toContain("old-writer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("WRITER-02: two independent broker clients cannot both hold the same physical scope", async () => {
    const left = createWorkspaceHostBroker({ root });
    const right = createWorkspaceHostBroker({ root });
    const servers = [
      await listenWorkspaceHostRpc({ broker: left }),
      await listenWorkspaceHostRpc({ broker: right }),
    ];
    try {
      const probe = await left.probeIdentity();
      expect((await right.probeIdentity()).scopeDigest).toBe(probe.scopeDigest);
      const authorityOf = (label: string) => ({
        invocationId: randomUUID(),
        runtimeRevisionId: randomUUID(),
        attemptId: randomUUID(),
        ownershipId: `${label}-${randomUUID()}`,
        leaseEpoch: "1",
        sessionBindingId: randomUUID(),
      });
      const clients = servers.map((server) => createRemoteWorkspaceHost(server.url));
      const results = await Promise.allSettled(
        clients.map((client, index) =>
          client.activateWriter({
            tenantId: TENANT_ID,
            scopeDigest: probe.scopeDigest,
            writerGeneration: index + 1,
            authority: authorityOf(`client-${index + 1}`),
            expectedStorageIdentity: probe.storageIdentity,
            operationId: nextOperationId(`writer-race-${index + 1}`),
            root,
          }),
        ),
      );
      const fulfilled = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const generations = fulfilled.map((grant) => grant.writerGeneration);
      // 代际严格单调：不可能两个客户端各自拿到同一个 generation 的授权。
      expect(new Set(generations).size).toBe(generations.length);
      // 控制面唯一：current writer 只有一个，且就是最高代际。
      const currentGeneration = Math.max(...generations);
      const current = await left.getWriter(probe.scopeDigest, currentGeneration);
      expect(current?.writerGeneration).toBe(currentGeneration);
      for (const generation of generations.filter((value) => value !== currentGeneration)) {
        await expect(left.getWriter(probe.scopeDigest, generation)).resolves.toBeNull();
      }
    } finally {
      for (const server of servers) await server.close();
    }
  }, 60_000);

  it("WRITER-03: two binding aliases of one physical root share exactly one scope", async () => {
    try {
      const broker = createWorkspaceHostBroker({ root });
      const probe = await broker.probeIdentity();
      const aliasA = await createBindingAtRoot({ root, probe, continuityMode: "SHARED_DURABLE" });
      const aliasB = await createBindingAtRoot({ root, probe, continuityMode: "SHARED_DURABLE" });
      // 别名（不同 Binding ID）指向同一物理写范围 → 同一个 scope，不能靠 Binding ID 绕过。
      expect(aliasA.storageScopeDigest).toBe(aliasB.storageScopeDigest);
      expect(aliasA.id).not.toBe(aliasB.id);
      const fixtureA = await seedPreparedRuntimeAttempt({ workspaceBinding: aliasA });
      const fixtureB = await seedPreparedRuntimeAttempt({ workspaceBinding: aliasB });
      const authorityA = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: fixtureA.invocation.id,
        attemptId: fixtureA.attempt.id,
        runtimeRevisionId: fixtureA.binding.runtimeRevisionId,
      });
      const candidateA = await prepareWorkspaceCandidate({
        attemptId: fixtureA.attempt.id,
        binding: aliasA,
        backend,
        root,
        operationId: nextOperationId("alias-a"),
        runtimeRevisionId: fixtureA.binding.runtimeRevisionId,
      });
      if (!candidateA) throw new Error("candidate missing");
      const activatedA = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: fixtureA.invocation.id,
        attemptId: fixtureA.attempt.id,
        ownership: authorityA.ownership,
        authority: authorityA.authority,
        candidate: candidateA,
      });
      // 第二个别名（另一个 Invocation）走同一 Broker：物理 scope 已被占用 → 拒绝。
      const authorityB = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: fixtureB.invocation.id,
        attemptId: fixtureB.attempt.id,
        runtimeRevisionId: fixtureB.binding.runtimeRevisionId,
      });
      const candidateB = await prepareWorkspaceCandidate({
        attemptId: fixtureB.attempt.id,
        binding: aliasB,
        backend,
        root,
        operationId: nextOperationId("alias-b"),
        runtimeRevisionId: fixtureB.binding.runtimeRevisionId,
      });
      if (!candidateB) throw new Error("alias B candidate missing");
      await expect(
        activatePreparedWorkspaceWriter({
          tenantId: TENANT_ID,
          invocationId: fixtureB.invocation.id,
          attemptId: fixtureB.attempt.id,
          ownership: authorityB.ownership,
          authority: authorityB.authority,
          candidate: candidateB,
        }),
      ).rejects.toThrow("父 Owner 仍然健康");
      expect(activatedA.writerGeneration).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("WRITER-04: the same path name with a replaced disk identity is rejected by real probing", async () => {
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const identityFile = path.join(root, ".snow", "workspace-identity.json");
    const record = JSON.parse(await readFile(identityFile, "utf8")) as Record<string, unknown>;
    // 真实身份已更换：路径名相同，但磁盘 inode 与持久记录不再匹配。
    await writeFile(
      identityFile,
      JSON.stringify({ ...record, inode: String(Number(record.inode) + 1) }),
      "utf8",
    );
    await expect(createWorkspaceHostBroker({ root }).probeIdentity()).rejects.toBeInstanceOf(
      WorkspaceIdentityMismatchError,
    );
    // 旧 Binding 冻结的 storageIdentity 不能靠路径名蒙混过关。
    const staleBinding = await createBindingAtRoot({
      root,
      probe,
      continuityMode: "SHARED_DURABLE",
    });
    const authority = {
      invocationId: randomUUID(),
      runtimeRevisionId: randomUUID(),
      attemptId: randomUUID(),
      ownershipId: randomUUID(),
      leaseEpoch: "1",
      sessionBindingId: randomUUID(),
    };
    await expect(
      broker.activateWriter({
        tenantId: TENANT_ID,
        scopeDigest: staleBinding.storageScopeDigest as string,
        writerGeneration: 1,
        authority,
        expectedStorageIdentity: staleBinding.storageIdentity as string,
        operationId: nextOperationId("replaced-disk"),
        root,
      }),
    ).rejects.toBeInstanceOf(WorkspaceIdentityMismatchError);
  }, 60_000);

  it("WRITER-05: a committed backend activation is recovered by its stable operation without a second writer", async () => {
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const operationId = nextOperationId("crash-after-activation");
    const authority = {
      invocationId: randomUUID(),
      runtimeRevisionId: randomUUID(),
      attemptId: randomUUID(),
      ownershipId: randomUUID(),
      leaseEpoch: "4",
      sessionBindingId: randomUUID(),
    };
    const first = await broker.activateWriter({
      tenantId: TENANT_ID,
      scopeDigest: probe.scopeDigest,
      writerGeneration: 1,
      authority,
      expectedStorageIdentity: probe.storageIdentity,
      operationId,
      root,
    });
    const spawned = await broker.spawnManagedWriter({
      tenantId: TENANT_ID,
      scopeDigest: probe.scopeDigest,
      writerGeneration: 1,
      command: process.execPath,
      args: continuousWriterArgs({
        targetFile: path.join(root, "writer-activity.log"),
        payload: "committed-writer",
      }),
      cwd: root,
      activityPath: path.join(root, "writer-activity.log"),
    });
    // DB 确认前 Crash：控制面没有 active 记录，但 Backend 回执已持久化。
    const recovered = await broker.activateWriter({
      tenantId: TENANT_ID,
      scopeDigest: probe.scopeDigest,
      writerGeneration: 1,
      authority,
      expectedStorageIdentity: probe.storageIdentity,
      operationId,
      root,
    });
    expect(recovered.grantRef).toBe(first.grantRef);
    expect(recovered.writerGeneration).toBe(1);
    // 已存在的受管 Writer 没有被重复开启，也没有被额外杀一次。
    expect(processAlive(spawned.pid)).toBe(true);
    expect((recovered.backendEvidence as Record<string, unknown>).previousWriterPresent).toBe(
      false,
    );
    await broker.assertWriter(recovered);
    process.kill(spawned.pid, "SIGKILL");
  }, 60_000);

  it("WRITER-06: a permanently lost HOST_AFFINE host fails closed instead of mounting a fresh directory", async () => {
    try {
      const broker = createWorkspaceHostBroker({ root });
      const probe = await broker.probeIdentity();
      // HOST_AFFINE 绑定必须绑定到真实注册设备。
      const user = await upsertUserIdentity({
        tenantId: TENANT_ID,
        externalSubject: `writer-06-${randomUUID()}`,
        email: "writer-06@example.com",
        displayName: "Writer 06",
      });
      const device = await registerDevice({
        tenantId: TENANT_ID,
        userId: user.id,
        deviceKey: `writer-06-${randomUUID()}`,
        publicKey: "test-public-key",
        deviceName: "Writer 06 Device",
        appVersion: "test",
      });
      const binding = await createBindingAtRoot({
        root,
        probe,
        continuityMode: "HOST_AFFINE",
        deviceId: device.id,
      });
      const fixture = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const authority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
      });
      const candidate = await prepareWorkspaceCandidate({
        attemptId: fixture.attempt.id,
        binding,
        backend,
        root,
        operationId: nextOperationId("host-affine"),
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
      });
      if (!candidate) throw new Error("candidate missing");
      const activated = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        ownership: authority.ownership,
        authority: authority.authority,
        candidate,
      });
      expect(activated.writerGeneration).toBe(1);

      // 原 Host 永久丢失：同一路径上新 Host 的持管身份与持久记录不一致 → fail closed。
      const impostor = createWorkspaceHostBroker({ root, hostIdentity: "host:replacement" });
      await expect(impostor.probeIdentity()).rejects.toBeInstanceOf(WorkspaceIdentityMismatchError);
      // 换一个全新的空目录冒充同一路径：scope 与冻结事实不同 → 拒绝。
      const emptyElsewhere = await mkdtemp(path.join(tmpdir(), "snowharness-fresh-host-"));
      try {
        const freshProbe = await createWorkspaceHostBroker({
          root: emptyElsewhere,
        }).probeIdentity();
        expect(freshProbe.scopeDigest).not.toBe(binding.storageScopeDigest);
        await expect(
          createWorkspaceHostBroker({ root: emptyElsewhere }).activateWriter({
            tenantId: TENANT_ID,
            scopeDigest: binding.storageScopeDigest as string,
            writerGeneration: 2,
            authority: authority.authority,
            expectedStorageIdentity: binding.storageIdentity as string,
            operationId: nextOperationId("lost-host"),
            root: emptyElsewhere,
          }),
        ).rejects.toBeInstanceOf(WorkspaceWriterNotFencedError);
      } finally {
        await rm(emptyElsewhere, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("WRITER-07: an unmanaged write path is rejected before any IO happens", async () => {
    try {
      const broker = createWorkspaceHostBroker({ root });
      const probe = await broker.probeIdentity();
      const binding = await createBindingAtRoot({ root, probe, continuityMode: "SHARED_DURABLE" });
      const first = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const firstAuthority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: first.attempt.id,
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      const firstCandidate = await prepareWorkspaceCandidate({
        attemptId: first.attempt.id,
        binding,
        backend,
        root,
        operationId: nextOperationId("gate-1"),
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      if (!firstCandidate) throw new Error("candidate missing");
      const generation1 = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: first.attempt.id,
        ownership: firstAuthority.ownership,
        authority: firstAuthority.authority,
        candidate: firstCandidate,
      });
      // 受管写入必须先通过 Broker 授权；授权返回的根是唯一可写范围。
      const authorized = await broker.authorizeWrite({
        scopeDigest: probe.scopeDigest,
        writerGeneration: generation1.writerGeneration,
        ownershipId: firstAuthority.ownership.id,
      });
      expect(authorized.root).toBe(generation1.grant.root);

      // 换代后旧 grant 的写入在真正 IO 之前被拒绝（换代只由父 Owner 失权 + W 路径复核驱动）。
      await closeExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        ownershipId: firstAuthority.ownership.id,
        state: "lost",
        reasonCode: "writer_superseded",
      });
      const attempt2 = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        retryReasonCode: "writer_superseded",
      });
      const attempt2Evidence = { kind: "workspace-supersede", attemptId: attempt2.id };
      await db.transaction((tx) =>
        markAttemptPreparedInTransaction(tx, {
          attemptId: attempt2.id,
          evidence: attempt2Evidence,
          digest: protocolDigest(attempt2Evidence),
        }),
      );
      const secondAuthority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: attempt2.id,
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      const secondCandidate = await prepareWorkspaceCandidate({
        attemptId: attempt2.id,
        binding,
        backend,
        root,
        operationId: nextOperationId("gate-2"),
        runtimeRevisionId: first.binding.runtimeRevisionId,
      });
      if (!secondCandidate) throw new Error("second candidate missing");
      // A07 决策四：`active` 行不得被直接覆盖 —— 先由释放 lane 真实停止旧 Writer 并写 `released`。
      const supersededRelease = await runWorkspaceWriterRelease({
        tenantId: TENANT_ID,
        lockId: generation1.lockId,
        leaseOwner: "writer-07-release",
        deps: { resolveHost: async () => backend.host },
      });
      expect(supersededRelease.outcome).toBe("released");
      await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: first.invocation.id,
        attemptId: attempt2.id,
        ownership: secondAuthority.ownership,
        authority: secondAuthority.authority,
        candidate: secondCandidate,
      });
      await expect(
        broker.authorizeWrite({
          scopeDigest: probe.scopeDigest,
          writerGeneration: generation1.writerGeneration,
          ownershipId: firstAuthority.ownership.id,
        }),
      ).rejects.toBeInstanceOf(WorkspaceWriterNotFencedError);
      await expect(broker.assertWriter(generation1.grant)).rejects.toThrow(
        "WorkspaceWriterNotFenced",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("WRITER-08: candidate cleanup refuses the shared root and the current owner root", async () => {
    try {
      const broker = createWorkspaceHostBroker({ root });
      const probe = await broker.probeIdentity();
      const binding = await createBindingAtRoot({ root, probe, continuityMode: "SHARED_DURABLE" });
      const owner = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const ownerAuthority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: owner.invocation.id,
        attemptId: owner.attempt.id,
        runtimeRevisionId: owner.binding.runtimeRevisionId,
      });
      const ownerCandidate = await prepareWorkspaceCandidate({
        attemptId: owner.attempt.id,
        binding,
        backend,
        root,
        operationId: nextOperationId("owner"),
        runtimeRevisionId: owner.binding.runtimeRevisionId,
      });
      if (!ownerCandidate) throw new Error("owner candidate missing");
      const ownerWriter = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: owner.invocation.id,
        attemptId: owner.attempt.id,
        ownership: ownerAuthority.ownership,
        authority: ownerAuthority.authority,
        candidate: ownerCandidate,
      });
      await writeFile(path.join(ownerWriter.grant.root, "owner.txt"), "owner bytes", "utf8");

      const other = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
      const otherCandidate = await prepareWorkspaceCandidate({
        attemptId: other.attempt.id,
        binding,
        backend,
        root,
        operationId: nextOperationId("victim"),
        runtimeRevisionId: other.binding.runtimeRevisionId,
      });
      if (!otherCandidate) throw new Error("victim candidate missing");
      const victimRoot = otherCandidate.preparation.candidateRoot;
      await mkdir(victimRoot, { recursive: true });
      await writeFile(path.join(victimRoot, "junk.txt"), "candidate bytes", "utf8");

      // 共享根 / 当前 Owner 写根 / 未注册目标：一律拒绝。
      await expect(
        broker.cleanup({ ...otherCandidate.preparation, candidateRoot: root }),
      ).rejects.toBeInstanceOf(WorkspaceCleanupRejectedError);
      await expect(
        broker.cleanup({ ...otherCandidate.preparation, candidateRoot: ownerWriter.grant.root }),
      ).rejects.toBeInstanceOf(WorkspaceCleanupRejectedError);
      await expect(
        broker.cleanup({
          ...otherCandidate.preparation,
          candidateRoot: path.join(root, "not-registered"),
        }),
      ).rejects.toBeInstanceOf(WorkspaceCleanupRejectedError);
      // 共享根与 Owner 目录未被触碰。
      await expect(readFile(path.join(ownerWriter.grant.root, "owner.txt"), "utf8")).resolves.toBe(
        "owner bytes",
      );

      // 正式清理只删除该 Candidate 的专属资源，且幂等。
      await broker.cleanup(otherCandidate.preparation);
      await expect(stat(victimRoot)).rejects.toThrow();
      await broker.cleanup(otherCandidate.preparation);
      await expect(readFile(path.join(ownerWriter.grant.root, "owner.txt"), "utf8")).resolves.toBe(
        "owner bytes",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/** 读回 WorkspaceWriteLock 行，用来断言"释放义务/回执/定位"的真实持久状态。 */
async function readLock(lockId: string) {
  const [row] = await db
    .select()
    .from(workspaceWriteLock)
    .where(and(eq(workspaceWriteLock.tenantId, TENANT_ID), eq(workspaceWriteLock.id, lockId)))
    .limit(1);
  if (!row) throw new Error("WorkspaceWriteLock 不存在");
  return row;
}
