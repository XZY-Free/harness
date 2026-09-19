/**
 * A07：WorkspaceHost 的**物理**写入与崩溃边界。
 *
 * 审查报告指出五处"看起来守住了、其实没有"的地方：
 *
 * 1. `freeze` 只检查 grant 并写安全点 JSON —— `authorizeWrite`/`spawnManagedWriter` 不读冻结
 *    状态，已登记的受管写进程也没有因 freeze 停止。形状合法的回执不能证明扫描期间没有写入。
 * 2. `workspace-writer.ts` 的 operationId 只按 Binding+scope+Attempt 生成，没有 Ownership/Epoch；
 *    同 Attempt 的第二次正式 Resume 会复用旧 operationId，命中旧回执并拿到旧代际的物理授权。
 * 3. `spawnManagedWriter` 不在 scope 临界区内：接管可以插在"检查旧 grant"与"spawn/登记"之间；
 *    spawn 成功后、登记 PID 前崩溃会留下没有持久归属记录的真实写者。
 * 4. `revokeWriterGeneration` 只停进程组，`current.json` 里的 grant 仍然可用
 *    （`getWriter`/`assertWriter`/`authorizeWrite` 照旧承认）。
 * 5. `.scope.lock` 靠 finally 删除：持锁进程被强杀后只剩一个无人认领的目录，新 Broker
 *    只能等到超时，没有任何"持有者是谁、是否失活"的可核验过程。
 *
 * 本文件是**端口级**验证：真实 Broker、真实文件、真实子进程与真实强杀，不涉及数据库。
 * 端到端的 Checkpoint/恢复链路见 `checkpoint-default-path.integration.test.ts`。
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import {
  WorkspaceWriterNotFencedError,
  continuousWriterArgs,
  createWorkspaceHostBroker,
} from "@/lib/workspace/workspace-host-server";
import { workspaceWriterActivationOperationId } from "@/lib/workspace/workspace-writer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";
const INTENT_ID = "00000000-0000-4000-8000-0000000000f1";
const ANCHOR_DIGEST = `sha256:${"a".repeat(64)}`;

function authority(overrides: Partial<AuthorityIdentity> = {}): AuthorityIdentity {
  return {
    invocationId: "00000000-0000-4000-8000-0000000000a1",
    runtimeRevisionId: "00000000-0000-4000-8000-0000000000a2",
    attemptId: "00000000-0000-4000-8000-0000000000a3",
    ownershipId: "00000000-0000-4000-8000-0000000000a4",
    leaseEpoch: "1",
    sessionBindingId: "00000000-0000-4000-8000-0000000000a5",
    ...overrides,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 进程退出不是瞬时的：断言"真的没了"必须轮询，否则会假失败。 */
async function waitForProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function scopeComponent(scopeDigest: string): string {
  return scopeDigest.replace(/^sha256:/, "");
}

/**
 * 捕获"Writer 未被真实 fence"。
 *
 * `WorkspaceWriterNotFencedError` 的 `message` 是稳定串（调用方按它分类），
 * 具体原因在 `detail` —— 因此原因断言必须打在 `detail` 上，否则会永远匹配不到。
 */
async function captureNotFenced(
  run: () => Promise<unknown>,
): Promise<WorkspaceWriterNotFencedError> {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown as Error,
  );
  expect(error).toBeInstanceOf(WorkspaceWriterNotFencedError);
  return error as WorkspaceWriterNotFencedError;
}

/** 外部"持锁子进程"注册表：测试结束后必须真实收掉，避免泄漏常驻进程。 */
const externalHolderPids: number[] = [];

interface Fixture {
  broker: ReturnType<typeof createWorkspaceHostBroker>;
  probe: Awaited<ReturnType<ReturnType<typeof createWorkspaceHostBroker>["probeIdentity"]>>;
  writerRoot: string;
  runRoot: string;
  controlRoot: string;
  grantsRoot: string;
  /** 受管 Writer 的持久归属记录目录。 */
  writersDir: string;
}

describe("WorkspaceHost 物理写入与崩溃边界（A07）", () => {
  let roots: string[] = [];
  let childPids: number[] = [];
  let childHandles: Array<ReturnType<typeof spawn>> = [];

  beforeEach(() => {
    roots = [];
    childPids = [];
    childHandles = [];
  });

  afterEach(async () => {
    // 真实子进程必须收干净：否则后续测试会被"存活的 Writer"干扰。
    for (const pid of externalHolderPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出。
      }
    }
    for (const pid of childPids.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // 进程组已不存在。
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出。
      }
    }
    for (const handle of childHandles.splice(0)) handle.kill("SIGKILL");
    for (const root of roots) await rm(root, { recursive: true, force: true });
    roots = [];
  });

  async function setup(): Promise<Fixture> {
    const base = await mkdtemp(path.join(tmpdir(), "a07-writer-"));
    roots.push(base);
    const hostRoot = path.join(base, "host");
    const writerRoot = path.join(base, "writer");
    const runRoot = path.join(writerRoot, "run");
    await mkdir(hostRoot, { recursive: true });
    await mkdir(runRoot, { recursive: true });
    const broker = createWorkspaceHostBroker({ root: hostRoot, managedRoot: writerRoot });
    const probe = await broker.probeIdentity();
    const controlRoot = path.join(await realpath(hostRoot), ".snow");
    return {
      broker,
      probe,
      writerRoot,
      runRoot,
      controlRoot,
      grantsRoot: path.join(controlRoot, "grants", scopeComponent(probe.scopeDigest)),
      writersDir: path.join(controlRoot, "writers"),
    };
  }

  /** 激活一份真实 grant（gen 1，可由调用方覆盖代际/执行权）。 */
  async function activate(
    fixture: Fixture,
    overrides: {
      writerGeneration?: number;
      authority?: AuthorityIdentity;
      operationId?: string;
      root?: string;
    } = {},
  ) {
    return fixture.broker.activateWriter({
      tenantId: TENANT_ID,
      scopeDigest: fixture.probe.scopeDigest,
      writerGeneration: overrides.writerGeneration ?? 1,
      authority: overrides.authority ?? authority(),
      expectedStorageIdentity: fixture.probe.storageIdentity,
      operationId: overrides.operationId ?? `op-${overrides.writerGeneration ?? 1}`,
      root: overrides.root ?? fixture.runRoot,
    });
  }

  /** 启动一个真实"持续写当前根"的受管子进程。 */
  async function spawnWriter(fixture: Fixture, generation = 1) {
    const activityPath = path.join(fixture.writerRoot, `writer-activity-${generation}.log`);
    const spawned = await fixture.broker.spawnManagedWriter({
      tenantId: TENANT_ID,
      scopeDigest: fixture.probe.scopeDigest,
      writerGeneration: generation,
      command: process.execPath,
      args: continuousWriterArgs({ targetFile: activityPath, payload: `gen-${generation}` }),
      cwd: fixture.writerRoot,
      activityPath,
    });
    childPids.push(spawned.processGroupId);
    return spawned;
  }

  it("7.1 freeze 建立物理写屏障：已登记 Writer 真实停止、授权与启动一律 fail closed", async () => {
    const fixture = await setup();
    const grant = await activate(fixture);
    const writeRequest = {
      scopeDigest: fixture.probe.scopeDigest,
      writerGeneration: 1,
      ownershipId: authority().ownershipId,
    };
    // 冻结之前授权出口是开的。
    await expect(fixture.broker.authorizeWrite(writeRequest)).resolves.toMatchObject({
      writerGeneration: 1,
    });

    const spawned = await spawnWriter(fixture);
    expect(isProcessAlive(spawned.pid)).toBe(true);

    const receipt = await fixture.broker.freeze({
      grant,
      checkpointIntentId: INTENT_ID,
      anchorDigest: ANCHOR_DIGEST,
    });
    expect(receipt.writerGeneration).toBe(1);

    // 核心：冻结不是"写一份漂亮回执" —— 已登记的 Writer 进程组真的没了。
    expect(await waitForProcessGone(spawned.pid)).toBe(true);
    // 屏障存在期间，写入授权与受管 Writer 启动都必须 fail closed。
    await expect(fixture.broker.authorizeWrite(writeRequest)).rejects.toThrow(
      WorkspaceWriterNotFencedError,
    );
    await expect(spawnWriter(fixture)).rejects.toThrow(WorkspaceWriterNotFencedError);
    // 停止证据是持久事实，可供审计（而不是只在返回值里出现一次）。
    const freeze = JSON.parse(
      await readFile(path.join(fixture.grantsRoot, "freeze.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(freeze).toMatchObject({
      checkpointIntentId: INTENT_ID,
      writerGeneration: 1,
      anchorDigest: ANCHOR_DIGEST,
    });
    expect(freeze.stopEvidence).toMatchObject({
      previousWriterPresent: true,
      stopped: true,
      processGroupEmpty: true,
    });

    // 解冻必须撤销屏障，否则该 scope 在安全点之后被永久锁死。
    await fixture.broker.releaseFreeze(receipt);
    await expect(fixture.broker.authorizeWrite(writeRequest)).resolves.toMatchObject({
      writerGeneration: 1,
    });
    expect(await pathExists(path.join(fixture.grantsRoot, "freeze.json"))).toBe(false);
  });

  it("7.2 激活幂等身份覆盖 Ownership 代际：同 operation 的新代际不得复用旧回执", async () => {
    const fixture = await setup();
    const first = await activate(fixture, { operationId: "op-identity" });

    // 同一 operationId，但换了执行权代际（同 Attempt 的第二次正式 Resume）。
    const replay = await activate(fixture, {
      writerGeneration: 2,
      authority: authority({
        ownershipId: "00000000-0000-4000-8000-0000000000b4",
        leaseEpoch: "2",
      }),
      operationId: "op-identity",
    }).then(
      () => null,
      (error: unknown) => error as WorkspaceWriterNotFencedError,
    );
    expect(replay).toBeInstanceOf(WorkspaceWriterNotFencedError);
    expect(replay?.detail).toMatch(/重放身份不一致/);
    // 关键：绝不能让新代际拿到旧 Owner 的物理授权。
    expect(await fixture.broker.getWriter(fixture.probe.scopeDigest, 2)).toBeNull();

    // 合法重放（完全相同的请求）仍必须幂等返回同一 receipt。
    const same = await activate(fixture, { operationId: "op-identity" });
    expect(same.grantRef).toBe(first.grantRef);
    expect(same.ownershipId).toBe(authority().ownershipId);
  });

  it("7.2 operationId 本身覆盖 Ownership/Epoch（同 Attempt 换代际不得同键）", () => {
    const base = {
      workspaceBindingId: "binding-1",
      storageScopeDigest: "sha256:scope",
      attemptId: "attempt-1",
    };
    const first = workspaceWriterActivationOperationId({
      ...base,
      ownershipId: "ownership-1",
      leaseEpoch: 1,
    });
    const nextGeneration = workspaceWriterActivationOperationId({
      ...base,
      ownershipId: "ownership-2",
      leaseEpoch: 2,
    });
    const retry = workspaceWriterActivationOperationId({
      ...base,
      ownershipId: "ownership-1",
      leaseEpoch: 1,
    });
    expect(nextGeneration).not.toBe(first);
    expect(retry).toBe(first);
  });

  it("7.3 spawn 与接管在同一临界区：并发启动同代际只有一个能成功", async () => {
    const fixture = await setup();
    await activate(fixture);
    const results = await Promise.allSettled([spawnWriter(fixture), spawnWriter(fixture)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    const rejection = (rejected as PromiseRejectedResult).reason as WorkspaceWriterNotFencedError;
    expect(rejection).toBeInstanceOf(WorkspaceWriterNotFencedError);
    expect(rejection.detail).toMatch(/已有\(或可能有\)存活的受管 Writer/);
    // 真实记录只有一条，且已被登记为 running。
    const record = JSON.parse(
      await readFile(
        path.join(fixture.writersDir, `${scopeComponent(fixture.probe.scopeDigest)}.1.json`),
        "utf8",
      ),
    ) as { phase: string; pid: number | null };
    expect(record.phase).toBe("running");
    expect(record.pid).not.toBeNull();
  });

  it("7.3 spawn 后登记前 Crash：不留无归属写者，且拒绝声明旧 Writer 已停止", async () => {
    const fixture = await setup();
    await activate(fixture);
    // 精确复现崩溃窗口留下的持久状态：启动意图已落盘、PID 尚未登记。
    // 这不是"造一个测试状态"，而是把真实崩溃写到盘上的那一份记录原样放回去。
    const intentPath = path.join(
      fixture.writersDir,
      `${scopeComponent(fixture.probe.scopeDigest)}.1.json`,
    );
    await mkdir(fixture.writersDir, { recursive: true });
    await writeFile(
      intentPath,
      JSON.stringify({
        scopeDigest: fixture.probe.scopeDigest,
        writerGeneration: 1,
        phase: "spawning",
        pid: null,
        processGroupId: null,
        command: `${process.execPath} writer.js`,
        activityPath: null,
        registeredAt: new Date().toISOString(),
      }),
    );

    // 1) 不能被当成"没有 Writer"而放行新启动。
    const blockedStart = await captureNotFenced(() => spawnWriter(fixture));
    expect(blockedStart.detail).toMatch(/已有\(或可能有\)存活的受管 Writer/);
    // 2) 接管不得声明"旧 Writer 已停止"后照常开新代际 —— 无法核验就不能前进。
    const blockedTakeover = await captureNotFenced(() =>
      activate(fixture, {
        writerGeneration: 2,
        authority: authority({
          ownershipId: "00000000-0000-4000-8000-0000000000b4",
          leaseEpoch: "2",
        }),
        operationId: "op-after-crash",
      }),
    );
    expect(blockedTakeover.detail).toMatch(/旧 Writer 进程组未确认停止/);
    // 3) 归属记录仍在（"没有 PID"不等于"没有归属"）。
    const record = JSON.parse(await readFile(intentPath, "utf8")) as { phase: string };
    expect(record.phase).toBe("spawning");
    expect(await fixture.broker.getWriter(fixture.probe.scopeDigest, 2)).toBeNull();
  });

  it("7.4 revoke 撤销可继续使用的 grant：查询/授权/启动一律失效，更高代际不受影响", async () => {
    const fixture = await setup();
    const grant = await activate(fixture);
    const spawned = await spawnWriter(fixture);
    const writeRequest = {
      scopeDigest: fixture.probe.scopeDigest,
      writerGeneration: 1,
      ownershipId: authority().ownershipId,
    };
    await expect(fixture.broker.authorizeWrite(writeRequest)).resolves.toMatchObject({
      writerGeneration: 1,
    });

    const evidence = await fixture.broker.revokeWriterGeneration(fixture.probe.scopeDigest, 1);
    expect(evidence.stopped).toBe(true);
    expect(await waitForProcessGone(spawned.pid)).toBe(true);

    // 进程停了不等于授权撤销：三者都必须不再承认这份 grant。
    await expect(fixture.broker.getWriter(fixture.probe.scopeDigest, 1)).resolves.toBeNull();
    await expect(fixture.broker.assertWriter(grant)).rejects.toThrow(WorkspaceWriterNotFencedError);
    await expect(fixture.broker.authorizeWrite(writeRequest)).rejects.toThrow(
      WorkspaceWriterNotFencedError,
    );
    await expect(spawnWriter(fixture)).rejects.toThrow(WorkspaceWriterNotFencedError);

    // 撤销本身是持久证据。
    const revocation = JSON.parse(
      await readFile(path.join(fixture.grantsRoot, "revoked", "1.json"), "utf8"),
    ) as { writerGeneration: number; evidence: { stopped: boolean } };
    expect(revocation.writerGeneration).toBe(1);
    expect(revocation.evidence.stopped).toBe(true);

    // 撤销旧代际不得挡住更高代际的正式激活。
    const next = await activate(fixture, {
      writerGeneration: 2,
      authority: authority({
        ownershipId: "00000000-0000-4000-8000-0000000000b4",
        leaseEpoch: "2",
      }),
      operationId: "op-after-revoke",
    });
    expect(next.writerGeneration).toBe(2);
  });

  it("7.5 持锁进程被强杀：新 Broker 凭归属证据回收，并留下回收记录", async () => {
    const fixture = await setup();
    const lockDir = path.join(fixture.grantsRoot, ".scope.lock");
    await mkdir(fixture.grantsRoot, { recursive: true });
    // 真实第二进程持有同格式的归属证据，随后被 SIGKILL —— finally 不会执行。
    const holder = await holdScopeLock({
      lockDir,
      hostIdentity: fixture.probe.hostIdentity,
      leaseMs: 60_000,
    });
    expect(await pathExists(path.join(lockDir, "owner.json"))).toBe(true);

    process.kill(holder.pid, "SIGKILL");
    expect(await waitForProcessGone(holder.pid)).toBe(true);

    // 不能等到超时：持有者已失活这一持久证据足以回收。
    const grant = await activate(fixture, { operationId: "op-after-lock-crash" });
    expect(grant.writerGeneration).toBe(1);
    expect(await pathExists(lockDir)).toBe(false);

    const recoveries = await readdir(path.join(fixture.grantsRoot, "lock-recoveries"));
    expect(recoveries.length).toBeGreaterThan(0);
    const record = JSON.parse(
      await readFile(path.join(fixture.grantsRoot, "lock-recoveries", recoveries[0]!), "utf8"),
    ) as { reason: string; previousOwner: { pid: number } | null };
    expect(record.reason).toBe("holder_dead");
    expect(record.previousOwner?.pid).toBe(holder.pid);
  }, 30_000);

  it("7.5 活着的持有者不会被回收：宁可等待超时也不抢锁", async () => {
    const fixture = await setup();
    const lockDir = path.join(fixture.grantsRoot, ".scope.lock");
    await mkdir(fixture.grantsRoot, { recursive: true });
    const holder = await holdScopeLock({
      lockDir,
      hostIdentity: fixture.probe.hostIdentity,
      leaseMs: 60_000,
    });

    const error = await activate(fixture, { operationId: "op-blocked" }).then(
      () => null,
      (thrown: unknown) => thrown as WorkspaceWriterNotFencedError,
    );
    expect(error).toBeInstanceOf(WorkspaceWriterNotFencedError);
    expect(error?.detail).toMatch(/scope 锁等待超时/);
    expect(error?.detail).toMatch(/依据=lease_active/);
    // 锁与归属证据都还在原持有者手里，且没有产生"回收"记录。
    expect(await pathExists(path.join(lockDir, "owner.json"))).toBe(true);
    expect(await pathExists(path.join(fixture.grantsRoot, "lock-recoveries"))).toBe(false);
    expect(isProcessAlive(holder.pid)).toBe(true);
  }, 30_000);

  it("7.5 跨 Host 的失效持有者凭租约回收；归属证据缺失则宽限后回收", async () => {
    // (a) 另一个 Host：无法探测对方 pid，只能凭"租约已过期"这一持久证据。
    const crossHost = await setup();
    const crossLockDir = path.join(crossHost.grantsRoot, ".scope.lock");
    await mkdir(crossLockDir, { recursive: true });
    await writeFile(
      path.join(crossLockDir, "owner.json"),
      JSON.stringify({
        holderId: "lock:elsewhere",
        hostIdentity: "host:elsewhere",
        pid: 1,
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    await expect(activate(crossHost, { operationId: "op-cross-host" })).resolves.toMatchObject({
      writerGeneration: 1,
    });
    const crossRecoveries = await readdir(path.join(crossHost.grantsRoot, "lock-recoveries"));
    const crossRecord = JSON.parse(
      await readFile(
        path.join(crossHost.grantsRoot, "lock-recoveries", crossRecoveries[0]!),
        "utf8",
      ),
    ) as { reason: string };
    expect(crossRecord.reason).toBe("cross_host_lease_expired");

    // (b) `mkdir` 之后、写归属证据之前被强杀：只有过了宽限才按证据回收。
    const orphaned = await setup();
    const orphanLockDir = path.join(orphaned.grantsRoot, ".scope.lock");
    await mkdir(orphanLockDir, { recursive: true });
    await expect(activate(orphaned, { operationId: "op-owner-missing" })).resolves.toMatchObject({
      writerGeneration: 1,
    });
    const orphanRecoveries = await readdir(path.join(orphaned.grantsRoot, "lock-recoveries"));
    const orphanRecord = JSON.parse(
      await readFile(
        path.join(orphaned.grantsRoot, "lock-recoveries", orphanRecoveries[0]!),
        "utf8",
      ),
    ) as { reason: string; previousOwner: unknown };
    expect(orphanRecord.reason).toBe("owner_record_missing");
    expect(orphanRecord.previousOwner).toBeNull();
  }, 30_000);
});

/**
 * 起一个**真实**子进程持有 scope 锁：写入与 Broker 完全同格式的归属证据后常驻。
 *
 * 这样"持锁进程被强杀"是真实事件（SIGKILL 不会执行任何清理），而不是把锁目录
 * 手工删掉再假装崩溃过。
 */
async function holdScopeLock(input: {
  lockDir: string;
  hostIdentity: string;
  leaseMs: number;
}): Promise<{ pid: number }> {
  const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const lockDir = process.argv[1];
    const hostIdentity = process.argv[2];
    const leaseMs = Number(process.argv[3]);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        holderId: "lock:external-holder",
        hostIdentity,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
      }),
    );
    process.stdout.write("held\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ["-e", script, input.lockDir, input.hostIdentity, String(input.leaseMs)],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await once(child.stdout!, "data");
  if (child.pid === undefined) throw new Error("锁持有者进程启动失败");
  externalHolderPids.push(child.pid);
  return { pid: child.pid };
}
