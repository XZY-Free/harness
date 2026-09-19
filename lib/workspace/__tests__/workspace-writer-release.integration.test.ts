/**
 * Workspace Writer 物理释放 lane 的回收闭环（R04 §3 / §5）。
 *
 * 每个用例都建立在**真实**事实之上：
 * - 旧 Writer 是真实子进程（持续写文件），由 Backend 真实终止其进程组；
 * - 释放工作的可见性只来自持久状态（父 Owner 失权 / 释放请求），不依赖任何显式撤销调用；
 * - 失败保留 `releasing` + 退避 + Backend 定位字段，重试与崩溃接管都在真实 DB 上验证。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { workspaceWriteLock } from "@/lib/persistence/schema/workspace-lock";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { type WorkspaceBackend, createWorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { computeWorkspaceContractDigest } from "@/lib/workspace/workspace-contract";
import {
  type WorkspaceHostIdentityProbe,
  continuousWriterArgs,
  createWorkspaceHostBroker,
} from "@/lib/workspace/workspace-host-server";
import { createWorkspace, createWorkspaceBinding } from "@/lib/workspace/workspace-queries";
import {
  WORKSPACE_RELEASE_LEASE_MS,
  claimWorkspaceWriterRelease,
  completeWorkspaceWriterRelease,
  requestWorkspaceWriterRelease,
  reserveWorkspaceWriter,
} from "@/lib/workspace/workspace-write-lock-queries";
import {
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
} from "@/lib/workspace/workspace-writer";
import {
  runDueWorkspaceWriterReleases,
  runWorkspaceWriterRelease,
} from "@/lib/workspace/workspace-writer-release";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

/** 停止增长确认（真实文件大小在等待窗口内不再变化）。 */
async function assertStopsGrowing(target: string) {
  const before = await fileSize(target);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await fileSize(target);
  if (after !== before) throw new Error(`受管 Writer 仍在写入：${before} -> ${after}`);
}

let sequence = 0;
function nextOperationId(prefix: string): string {
  sequence += 1;
  return `${prefix}:${sequence}:${randomUUID()}`;
}

async function createBindingAtRoot(input: {
  root: string;
  probe: WorkspaceHostIdentityProbe;
  continuityMode: "HOST_AFFINE" | "SHARED_DURABLE";
}) {
  const logical = await createWorkspace({
    tenantId: TENANT_ID,
    workspaceKey: `writer-release-${randomUUID()}`,
    displayName: "Writer release fixture",
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
  return createWorkspaceBinding({
    tenantId: TENANT_ID,
    workspaceId: logical.id,
    continuityMode: input.continuityMode,
    bindingType: "sandbox",
    deviceId: null,
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
}

async function readLock(lockId: string) {
  const [row] = await db
    .select()
    .from(workspaceWriteLock)
    .where(and(eq(workspaceWriteLock.tenantId, TENANT_ID), eq(workspaceWriteLock.id, lockId)))
    .limit(1);
  if (!row) throw new Error("WorkspaceWriteLock 不存在");
  return row;
}

describe("Workspace writer release lane integration", () => {
  let roots: string[] = [];
  const envKeys = ["SNOWHARNESS_WORKSPACE_HOST_ROOT"] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
    roots = [];
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
  });

  afterEach(async () => {
    for (const key of envKeys) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const root of roots) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(root, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    roots = [];
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "snowharness-writer-release-"));
    roots.push(root);
    return root;
  }

  /** 建立一个真实 active generation，并绑定一个持续写文件的真实子进程。 */
  async function activateWithRealWriter(input: {
    root: string;
    broker: ReturnType<typeof createWorkspaceHostBroker>;
    probe: WorkspaceHostIdentityProbe;
    continuityMode?: "HOST_AFFINE" | "SHARED_DURABLE";
  }) {
    const binding = await createBindingAtRoot({
      root: input.root,
      probe: input.probe,
      continuityMode: input.continuityMode ?? "SHARED_DURABLE",
    });
    const fixture = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
    const authority = await acquireTestRuntimeAuthority({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const backend: WorkspaceBackend = createWorkspaceBackend(input.broker);
    const candidate = await prepareWorkspaceCandidate({
      attemptId: fixture.attempt.id,
      binding,
      backend,
      root: input.root,
      operationId: nextOperationId("release-lane"),
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
    const activityFile = path.join(input.root, `writer-activity-${randomUUID()}.log`);
    const spawned = await input.broker.spawnManagedWriter({
      tenantId: TENANT_ID,
      scopeDigest: input.probe.scopeDigest,
      writerGeneration: activated.writerGeneration,
      command: process.execPath,
      args: continuousWriterArgs({ targetFile: activityFile, payload: "release-lane" }),
      cwd: input.root,
      activityPath: activityFile,
    });
    await waitForGrowth(activityFile, 64);
    return { binding, fixture, authority, activated, activityFile, spawned, candidate, backend };
  }

  it("WFENCE-01: 父 Owner 失权后，lane 用生产解析真实终止旧 Writer 并收口 slot", async () => {
    const root = await makeRoot();
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const run = await activateWithRealWriter({ root, broker, probe });

    // I 侧只写"Owner 已失权"这一持久事实，**不**做任何 W 行撤销。
    await closeExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: run.fixture.invocation.id,
      ownershipId: run.authority.ownership.id,
      state: "lost",
      reasonCode: "runtime_process_lost",
    });
    const before = await readLock(run.activated.lockId);
    expect(before.lockState).toBe("active");
    expect(before.writerGeneration).toBe(run.activated.writerGeneration);
    expect(processAlive(run.spawned.pid)).toBe(true);

    // 生产解析路径（env root → 新建 Broker 实例）：只凭持久状态发现旧 Writer。
    process.env.SNOWHARNESS_WORKSPACE_HOST_ROOT = root;
    const summary = await runDueWorkspaceWriterReleases({ leaseOwner: "test-worker:1", limit: 10 });
    expect(summary.scanned).toBe(1);
    expect(summary.released).toBe(1);
    expect(summary.retried).toBe(0);

    const after = await readLock(run.activated.lockId);
    expect(after.lockState).toBe("released");
    expect(after.releaseReasonCode).toBe("writer_owner_no_longer_current");
    expect(after.releaseAttemptCount).toBe(1);
    expect(after.releaseErrorCode).toBeNull();
    // released 形状：holder 与 Backend 定位字段全部清空，回执保留。
    expect(after.holderInvocationId).toBeNull();
    expect(after.holderAttemptId).toBeNull();
    expect(after.holderOwnershipId).toBeNull();
    expect(after.workspaceBindingId).toBeNull();
    expect(after.backendGrantRef).toBeNull();
    expect(after.backendOperationId).toBeNull();
    expect(after.backendEvidence).toBeNull();
    expect(after.backendReceipt).toBeNull();
    const receipt = after.releaseReceipt as {
      previousWriterPresent?: boolean;
      stopped?: boolean;
      processGroupEmpty?: boolean;
      pids?: number[];
    } | null;
    expect(receipt?.previousWriterPresent).toBe(true);
    expect(receipt?.stopped).toBe(true);
    expect(receipt?.processGroupEmpty).toBe(true);
    expect(receipt?.pids).toContain(run.spawned.pid);

    // 真实进程已退出，磁盘不再增长。
    expect(processAlive(run.spawned.pid)).toBe(false);
    await assertStopsGrowing(run.activityFile);

    // 幂等：再次运行没有候选，也不会改动已收口的行。
    const second = await runDueWorkspaceWriterReleases({
      leaseOwner: "test-worker:2",
      limit: 10,
    });
    expect(second.scanned).toBe(0);
    const reread = await readLock(run.activated.lockId);
    expect(reread.lockState).toBe("released");
    expect(reread.versionNo).toBe(after.versionNo);
  });

  it("WFENCE-02: 健康父 Owner 的 slot 不被释放，只被跳过并推迟复检", async () => {
    const root = await makeRoot();
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const run = await activateWithRealWriter({ root, broker, probe });

    const summary = await runDueWorkspaceWriterReleases({
      leaseOwner: "test-worker:1",
      limit: 10,
      deps: { resolveHost: async () => broker },
    });
    // 候选只取 ID（扫描可见），但领取时复核父 Owner 健康 → 一律跳过。
    expect(summary.scanned).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.released).toBe(0);

    const lock = await readLock(run.activated.lockId);
    expect(lock.lockState).toBe("active");
    expect(lock.writerGeneration).toBe(run.activated.writerGeneration);
    expect(lock.holderInvocationId).toBe(run.fixture.invocation.id);
    expect(lock.releaseLeaseOwner).toBeNull();
    expect(lock.releaseNextAttemptAt).not.toBeNull();
    // 真实 Writer 未被误杀：仍在持续写入。
    expect(processAlive(run.spawned.pid)).toBe(true);
    await assertStopsGrowingByGrowth(run.activityFile);
    // 显式收尾（也证明该 generation 仍受 Backend 实际管理）。
    const stopped = await broker.revokeWriterGeneration(
      probe.scopeDigest,
      run.activated.writerGeneration,
    );
    expect(stopped.stopped).toBe(true);
    expect(processAlive(run.spawned.pid)).toBe(false);
  });

  it("WFENCE-03: 释放失败保留持久定位与退避，退避到期后重试完成回收", async () => {
    const root = await makeRoot();
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const run = await activateWithRealWriter({ root, broker, probe });
    await closeExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: run.fixture.invocation.id,
      ownershipId: run.authority.ownership.id,
      state: "lost",
      reasonCode: "runtime_process_lost",
    });

    const now = new Date();
    const failed = await runWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: run.activated.lockId,
      leaseOwner: "test-worker:1",
      deps: {
        now,
        resolveHost: async () => {
          const failure = new Error("WorkspaceHostUnavailable");
          failure.name = "WorkspaceHostUnavailable";
          throw failure;
        },
      },
    });
    expect(failed.outcome).toBe("retry_scheduled");

    const afterFailure = await readLock(run.activated.lockId);
    expect(afterFailure.lockState).toBe("releasing");
    expect(afterFailure.releaseAttemptCount).toBe(1);
    expect(afterFailure.releaseErrorCode).toBe("WorkspaceHostUnavailable");
    expect(afterFailure.releaseNextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(afterFailure.releaseLeaseOwner).toBeNull();
    // §7：不能先清空 Backend 引用后失去清理定位。
    expect(afterFailure.workspaceBindingId).toBe(run.binding.id);
    expect(afterFailure.backendGrantRef).not.toBeNull();
    expect(afterFailure.backendOperationId).not.toBeNull();
    expect(afterFailure.storageScopeDigest).toBe(probe.scopeDigest);
    expect(afterFailure.holderInvocationId).toBe(run.fixture.invocation.id);
    // 真实 Writer 仍在运行（失败不等于已释放）。
    expect(processAlive(run.spawned.pid)).toBe(true);

    // 退避未到期：不在候选内。
    const early = await runDueWorkspaceWriterReleases({
      leaseOwner: "test-worker:2",
      limit: 10,
      now,
      deps: { now, resolveHost: async () => broker },
    });
    expect(early.scanned).toBe(0);

    // 到期后由正式 Worker 重试，真实释放成功。
    const retryAt = new Date((afterFailure.releaseNextAttemptAt as Date).getTime() + 1);
    const recovered = await runDueWorkspaceWriterReleases({
      leaseOwner: "test-worker:2",
      limit: 10,
      now: retryAt,
      deps: { now: retryAt, resolveHost: async () => broker },
    });
    expect(recovered.released).toBe(1);

    const released = await readLock(run.activated.lockId);
    expect(released.lockState).toBe("released");
    expect(released.releaseAttemptCount).toBe(2);
    expect(released.releaseErrorCode).toBeNull();
    expect(processAlive(run.spawned.pid)).toBe(false);
    await assertStopsGrowing(run.activityFile);
  });

  it("WFENCE-04: 释放期间发生新 Owner 接管时不被误杀（superseded）", async () => {
    const root = await makeRoot();
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const run = await activateWithRealWriter({ root, broker, probe });
    await closeExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: run.fixture.invocation.id,
      ownershipId: run.authority.ownership.id,
      state: "lost",
      reasonCode: "runtime_process_lost",
    });

    const now = new Date();
    const claimed = await claimWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: run.activated.lockId,
      leaseOwner: "test-worker:1",
      now,
    });
    expect(claimed.outcome).toBe("claimed");

    // 新 Attempt 接管同一 scope：父 Owner 已失权 → 取得下一代 generation。
    const attempt2 = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: run.fixture.invocation.id,
      retryReasonCode: "runtime_recovered",
    });
    const retryEvidence = { kind: "writer-release-supersede", attemptId: attempt2.id };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: attempt2.id,
        evidence: retryEvidence,
        digest: protocolDigest(retryEvidence),
      }),
    );
    const authority2 = await acquireTestRuntimeAuthority({
      tenantId: TENANT_ID,
      invocationId: run.fixture.invocation.id,
      attemptId: attempt2.id,
      runtimeRevisionId: run.fixture.binding.runtimeRevisionId,
    });
    const reserved2 = await reserveWorkspaceWriter({
      tenantId: TENANT_ID,
      storageScopeDigest: probe.scopeDigest,
      invocationId: run.fixture.invocation.id,
      attemptId: attempt2.id,
      ownershipId: authority2.ownership.id,
      workspaceBindingId: run.binding.id,
      leaseExpiresAt: authority2.ownership.leaseExpiresAt,
    });
    expect(reserved2.writerGeneration).toBe(run.activated.writerGeneration + 1);
    await activatePreparedWorkspaceWriter({
      tenantId: TENANT_ID,
      invocationId: run.fixture.invocation.id,
      attemptId: attempt2.id,
      ownership: authority2.ownership,
      authority: authority2.authority,
      candidate: { ...run.candidate, root: run.candidate.root },
    });

    // 旧 Worker 的完成回执不能改动已被新 generation 接管的行。
    const completed = await completeWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: run.activated.lockId,
      leaseOwner: "test-worker:1",
      reasonCode: "writer_owner_no_longer_current",
      releaseReceipt: { mode: "stale-completion" },
      now,
    });
    expect(completed.outcome).toBe("superseded");

    const lock = await readLock(run.activated.lockId);
    expect(lock.lockState).toBe("active");
    expect(lock.writerGeneration).toBe(reserved2.writerGeneration);
    expect(lock.holderAttemptId).toBe(attempt2.id);
    expect(lock.holderOwnershipId).toBe(authority2.ownership.id);
    expect(lock.releaseReceipt).toBeNull();
    // 物理 writer 归新 generation：旧 Writer 已被 Broker 换代终止，新 grant 仍可授权写入。
    const authorized = await broker.authorizeWrite({
      scopeDigest: probe.scopeDigest,
      writerGeneration: reserved2.writerGeneration,
      ownershipId: authority2.ownership.id,
    });
    expect(authorized.writerGeneration).toBe(reserved2.writerGeneration);
  });

  it("WFENCE-05: 释放 Worker 崩溃后领取权过期即被另一 Worker 接管并完成回收", async () => {
    const root = await makeRoot();
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const run = await activateWithRealWriter({ root, broker, probe });
    await closeExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: run.fixture.invocation.id,
      ownershipId: run.authority.ownership.id,
      state: "lost",
      reasonCode: "runtime_process_lost",
    });

    const now = new Date();
    // 模拟 Worker 领取后进程崩溃：DB 留下 releasing + 未过期的领取权。
    const claimed = await claimWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: run.activated.lockId,
      leaseOwner: "test-worker:crashed",
      now,
    });
    expect(claimed.outcome).toBe("claimed");
    const crashed = await readLock(run.activated.lockId);
    expect(crashed.lockState).toBe("releasing");
    expect(crashed.releaseLeaseOwner).toBe("test-worker:crashed");

    // 领取权仍在有效期内：其他 Worker 既扫不到也不能改结论。
    const stillLeased = new Date(now.getTime() + WORKSPACE_RELEASE_LEASE_MS / 2);
    const blocked = await runDueWorkspaceWriterReleases({
      leaseOwner: "test-worker:takeover",
      limit: 10,
      now: stillLeased,
      deps: { now: stillLeased, resolveHost: async () => broker },
    });
    expect(blocked.scanned).toBe(0);
    const direct = await claimWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: run.activated.lockId,
      leaseOwner: "test-worker:takeover",
      now: stillLeased,
    });
    expect(direct.outcome).toBe("skipped");
    expect(processAlive(run.spawned.pid)).toBe(true);

    // 领取权过期 → 另一 Worker 接管并完成真实回收。
    const takeoverAt = new Date(now.getTime() + WORKSPACE_RELEASE_LEASE_MS + 1);
    const recovered = await runDueWorkspaceWriterReleases({
      leaseOwner: "test-worker:takeover",
      limit: 10,
      now: takeoverAt,
      deps: { now: takeoverAt, resolveHost: async () => broker },
    });
    expect(recovered.released).toBe(1);
    const released = await readLock(run.activated.lockId);
    expect(released.lockState).toBe("released");
    expect(released.releaseAttemptCount).toBe(2);
    expect(released.releaseLeaseOwner).toBeNull();
    expect(processAlive(run.spawned.pid)).toBe(false);
  });

  it("WFENCE-06: I 侧持久释放请求对健康持有者同样生效（清空引用前先完成真实释放）", async () => {
    const root = await makeRoot();
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const run = await activateWithRealWriter({ root, broker, probe });

    // 父 Owner 仍健康，但 I 侧已写持久释放请求（如激活失败补偿）。
    await requestWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: run.activated.lockId,
      ownershipId: run.authority.ownership.id,
      reasonCode: "writer_activation_failed",
    });
    const requested = await readLock(run.activated.lockId);
    expect(requested.lockState).toBe("releasing");
    expect(requested.releaseReasonCode).toBe("writer_activation_failed");

    const summary = await runDueWorkspaceWriterReleases({
      leaseOwner: "test-worker:1",
      limit: 10,
      deps: { resolveHost: async () => broker },
    });
    expect(summary.released).toBe(1);
    const released = await readLock(run.activated.lockId);
    expect(released.lockState).toBe("released");
    expect(released.releaseReasonCode).toBe("writer_activation_failed");
    expect(processAlive(run.spawned.pid)).toBe(false);
    // 幂等：请求已收口后不再产生候选。
    const second = await runDueWorkspaceWriterReleases({
      leaseOwner: "test-worker:2",
      limit: 10,
      deps: { resolveHost: async () => broker },
    });
    expect(second.scanned).toBe(0);
  });

  it("WFENCE-07: 请求释放不会误标他人持有的 slot", async () => {
    const root = await makeRoot();
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const run = await activateWithRealWriter({ root, broker, probe });

    const stranger = await requestWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: run.activated.lockId,
      ownershipId: randomUUID(),
      reasonCode: "writer_activation_failed",
    });
    expect(stranger?.lockState).toBe("active");
    const lock = await readLock(run.activated.lockId);
    expect(lock.lockState).toBe("active");
    expect(processAlive(run.spawned.pid)).toBe(true);
  });
  it("WFENCE-08: 健康槽位占满批次时，后排到期的释放工作仍被处理（A08 8.3 公平扫描）", async () => {
    const root = await makeRoot();
    const broker = createWorkspaceHostBroker({ root });
    const probe = await broker.probeIdentity();
    const run = await activateWithRealWriter({ root, broker, probe });

    /**
     * 一个 storage scope 一行（`WorkspaceWriteLock_tenant_scope_uq`），因此"健康槽位多于批次上限"
     * 与生产同构：多个 Workspace 各自的 scope 各占一行。
     */
    const HEALTHY_SLOTS = 4;
    const syntheticScope = (index: number) => `sha256:${index.toString(16).padStart(64, "0")}`;

    const healthyLockIds: string[] = [];
    const healthyUpdatedAt: number[] = [];
    for (let index = 1; index <= HEALTHY_SLOTS; index += 1) {
      const reserved = await reserveWorkspaceWriter({
        tenantId: TENANT_ID,
        storageScopeDigest: syntheticScope(index),
        invocationId: run.fixture.invocation.id,
        attemptId: run.fixture.attempt.id,
        ownershipId: run.authority.ownership.id,
        workspaceBindingId: run.binding.id,
        leaseExpiresAt: run.authority.ownership.leaseExpiresAt,
      });
      healthyLockIds.push(reserved.lock.id);
      healthyUpdatedAt.push(reserved.lock.updatedAt.getTime());
    }

    // 释放请求发生在健康槽位**之后**（保证 updatedAt 严格更晚），且 `lockState=releasing`。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reservedForRelease = await reserveWorkspaceWriter({
      tenantId: TENANT_ID,
      storageScopeDigest: syntheticScope(99),
      invocationId: run.fixture.invocation.id,
      attemptId: run.fixture.attempt.id,
      ownershipId: run.authority.ownership.id,
      workspaceBindingId: run.binding.id,
      leaseExpiresAt: run.authority.ownership.leaseExpiresAt,
    });
    const requested = await requestWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: reservedForRelease.lock.id,
      reasonCode: "writer_owner_no_longer_current",
    });
    expect(requested?.lockState).toBe("releasing");

    // 排序前提必须显式成立（不成立就是夹具问题，而不是扫描问题）：
    // 全部候选的 `releaseNextAttemptAt` 都是 NULL，旧实现只按 updatedAt 升序取批次，
    // 于是健康槽位在前、这条到期的 releasing 行在后。
    const releasingRow = await readLock(reservedForRelease.lock.id);
    expect(releasingRow.releaseNextAttemptAt).toBeNull();
    expect(Math.max(...healthyUpdatedAt)).toBeLessThan(releasingRow.updatedAt.getTime());

    // 批次上限 = 健康槽位数 < 候选总数：到期的释放工作本应被前排健康槽位挤掉。
    const summary = await runDueWorkspaceWriterReleases({
      leaseOwner: "test-worker:fairness",
      limit: HEALTHY_SLOTS,
    });
    expect(summary.released).toBe(1);
    expect((await readLock(reservedForRelease.lock.id)).lockState).toBe("released");
    // 健康槽位一行都没被触碰（只被跳过并推迟复检）。
    for (const lockId of healthyLockIds) {
      const lock = await readLock(lockId);
      expect(lock.lockState).toBe("reserved");
      expect(lock.holderOwnershipId).toBe(run.authority.ownership.id);
    }
    // 本用例自己起的真实 Writer 收干净，避免影响同文件后续用例。
    try {
      process.kill(-run.spawned.pid, "SIGKILL");
    } catch {
      // 进程已退出
    }
  });
});

/** 断言文件在等待窗口内**继续**增长（证明真实 Writer 仍存活，未被误杀）。 */
async function assertStopsGrowingByGrowth(target: string) {
  const before = await fileSize(target);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await fileSize(target);
  if (after <= before) throw new Error(`受管 Writer 已停止写入：${before} -> ${after}`);
}
