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
 * 5. `.scope.lock` 曾是 `mkdir` 出来的目录、靠 finally 删除，回收只能靠 `rename` 别人的目录 ——
 *    "读持有者"与"rename"之间的间隙正是路径替换竞争。现在锁落在**稳定文件**的内核排他锁上
 *    （`native/workspace-lock`），崩溃由 OS 释放，锁文件从不被 rename/unlink/recreate。
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
  ScopeLockBusyError,
  scopeLockFilePath,
  scopeLockIdentity,
  tryAcquireScopeLock,
  withScopeLock,
} from "@/lib/workspace/scope-lock";
import {
  activitySize,
  detachedWriterArgs,
  fileStillGrowing,
  killByPid,
  readDetachedWriterPid,
  startWriterBrokerProbe,
  waitForActivityIdle,
  waitForFileExists,
} from "@/lib/workspace/test-support/physical-writer-process";
import type { WorkspaceWriterGrant, WorkspaceWriterIdentity } from "@/lib/workspace/workspace-host";
import {
  WorkspaceWriterNotFencedError,
  continuousWriterArgs,
  createWorkspaceHostBroker,
} from "@/lib/workspace/workspace-host-server";
import { workspaceWriterActivationOperationId } from "@/lib/workspace/workspace-writer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";
const INTENT_ID = "00000000-0000-4000-8000-0000000000f1";
/** 原生 provider 的位置：子进程脚本按同一路径加载（与生产走同一个二进制）。 */
const NATIVE_MODULE_DIR = path.join(process.cwd(), "native", "workspace-lock");
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

/**
 * 撤销契约的**精确归属身份**（A07 决策五）：从真实激活回执构造。
 *
 * 刻意不提供"只传 scope + generation"的便捷写法 —— 那正是要被消灭的调用形态。
 */
function revocationIdentity(
  grant: WorkspaceWriterGrant,
  overrides: Partial<WorkspaceWriterIdentity> = {},
): WorkspaceWriterIdentity {
  return {
    tenantId: TENANT_ID,
    scopeDigest: grant.scopeDigest,
    writerGeneration: grant.writerGeneration,
    invocationId: grant.invocationId,
    attemptId: grant.attemptId,
    ownershipId: grant.ownershipId,
    operationId: grant.operationId,
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

/** 递归扫描目录的相对路径集合（"冻结期间文件扫描一致"的断言依据）。 */
async function scanTree(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await scanTree(root, next)));
    else out.push(next);
  }
  return out;
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
  /** 控制面根（未追加 `.snow`）。 */
  hostRoot: string;
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
      hostRoot,
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

  /**
   * 启动一个"登记过的进程组已空、孙进程仍在写"的受管 Writer。
   *
   * 这不是模拟：`spawnManagedWriter` 记录父进程的进程组，父进程随即退出，
   * 而真正写文件的孙进程在**独立进程组**里继续写。于是 Broker 只能靠
   * `activityPath` 的写入排空才能确认停止 —— 正是 A07 要求区分的那两件事。
   */
  async function spawnDetachedWriter(fixture: Fixture, generation = 1) {
    const activityPath = path.join(fixture.writerRoot, `detached-activity-${generation}.log`);
    const pidFile = path.join(fixture.writerRoot, `detached-writer-${generation}.pid`);
    const spawned = await fixture.broker.spawnManagedWriter({
      tenantId: TENANT_ID,
      scopeDigest: fixture.probe.scopeDigest,
      writerGeneration: generation,
      command: process.execPath,
      args: detachedWriterArgs({ activityPath, pidFile }),
      cwd: fixture.writerRoot,
      activityPath,
    });
    // 父进程通常已退出；登记它只是为了让收尾清理对 ESRCH 也保持幂等。
    childPids.push(spawned.processGroupId);
    const childPid = await readDetachedWriterPid(pidFile);
    // 孙进程先落 PID 文件，**下一个 tick（20ms）才第一次 append**。断言"写入尚未排空"
    // 之前必须先证明它真的在写：否则活动文件尚不存在时，Broker 的排空判定会把
    // "观测不到活动"当成"没有活动"（`awaitActivityDrain` 对缺失文件返回 true），
    // 从而把 stopped 伪造成 true —— 这正是本文件要排除的假阳性。
    await waitForFileExists(activityPath);
    if (!(await fileStillGrowing(activityPath))) {
      throw new Error(`游离 Writer 未建立真实写入活动：${activityPath}`);
    }
    // 真正在写的是这个游离孙进程：必须由收尾真实收掉，否则会污染后续用例。
    externalHolderPids.push(childPid);
    return { spawned, childPid, activityPath, pidFile };
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

    const evidence = await fixture.broker.revokeWriterGeneration(revocationIdentity(grant));
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

  /**
   * A07-T01：两个等待者不会回收新持有者的锁。
   *
   * 真实 native provider、真实第二进程。A 取得锁并持续持有期间：
   * - B（本进程的 `withScopeLock`）只能有界失败，绝不 rename/unlink A 的锁文件；
   * - 真实 Broker 激活路径同样只能得到"可重试占用"，且**不产生**任何回收记录；
   * - A 被真实 SIGKILL 后才允许进入，且锁文件的 inode 身份前后完全一致
   *   （证明锁文件从未被 rename/unlink/recreate）。
   */
  it("A07-T01 两个等待者不会回收新持有者的锁：A 临界区内 B 不得进入，锁文件身份不变", async () => {
    const fixture = await setup();
    const lockPath = scopeLockFilePath(fixture.grantsRoot);
    await mkdir(path.dirname(lockPath), { recursive: true });

    const holderA = await spawnNativeLockHolder(lockPath);
    const identityWhileHeld = scopeLockIdentity(lockPath);

    const busy = await withScopeLock({
      lockPath,
      timeoutMs: 300,
      retryMs: 10,
      run: async () => "entered",
    }).then(
      () => null,
      (thrown: unknown) => thrown as ScopeLockBusyError,
    );
    expect(busy).toBeInstanceOf(ScopeLockBusyError);
    expect(busy?.lockPath).toBe(lockPath);

    // 真实 Broker 路径：A 持锁期间既不能激活出 Writer，也不能"回收"别人的锁。
    const notFenced = await captureNotFenced(() =>
      activate(fixture, { operationId: "op-during-hold" }),
    );
    expect(notFenced.detail).toMatch(/可重试占用/);
    expect(await pathExists(path.join(fixture.grantsRoot, "lock-recoveries"))).toBe(false);
    expect(await pathExists(lockPath)).toBe(true);
    expect(await pathExists(path.join(lockPath, "owner.json"))).toBe(false);

    // A 被强杀（真实事件：没有任何 finally 会执行）后，OS 释放，B 才允许进入。
    process.kill(holderA.pid as number, "SIGKILL");
    expect(await waitForProcessGone(holderA.pid as number)).toBe(true);
    const entered = await withScopeLock({
      lockPath,
      timeoutMs: 5_000,
      retryMs: 10,
      run: async () => "entered",
    });
    expect(entered).toBe("entered");

    const identityAfter = scopeLockIdentity(lockPath);
    expect(identityAfter.inode).toBe(identityWhileHeld.inode);
    expect(identityAfter.device).toBe(identityWhileHeld.device);
  }, 30_000);

  /**
   * A07-T02：持锁进程崩溃后由 OS 自动释放。
   *
   * 不存在"凭归属证据回收"这一步：真实 Broker 必须直接成功，且全程没有
   * `lock-recoveries`、没有目录锁残留、锁文件 inode 不变。
   */
  it("A07-T02 持锁进程崩溃自动释放：下一个合法持有者直接进入，无需 stale 持有者 rename", async () => {
    const fixture = await setup();
    const lockPath = scopeLockFilePath(fixture.grantsRoot);
    await mkdir(path.dirname(lockPath), { recursive: true });

    const holder = await spawnNativeLockHolder(lockPath);
    const identityBefore = scopeLockIdentity(lockPath);
    process.kill(holder.pid as number, "SIGKILL");
    expect(await waitForProcessGone(holder.pid as number)).toBe(true);

    const grant = await activate(fixture, { operationId: "op-after-lock-crash" });
    expect(grant.writerGeneration).toBe(1);
    expect(await pathExists(path.join(fixture.grantsRoot, "lock-recoveries"))).toBe(false);
    expect(await pathExists(lockPath)).toBe(true);
    expect(scopeLockIdentity(lockPath).inode).toBe(identityBefore.inode);
  }, 30_000);

  /**
   * A07-T03：锁句柄不被用户子进程继承。
   *
   * Broker 取得锁的 fd 以 `O_CLOEXEC` 打开，因此它 spawn 出的用户 Writer 子进程
   * 不会"替 Broker 一直握着"这把锁。观察方式：父进程持锁时独立进程必须 busy；
   * 父进程释放后，**仍存活**的子进程不得继续持有 —— 独立进程立刻能取得。
   */
  it("A07-T03 锁句柄不被用户进程继承：父进程释放后仍存活的子进程不持有锁", async () => {
    const fixture = await setup();
    const lockPath = scopeLockFilePath(fixture.grantsRoot);
    await mkdir(path.dirname(lockPath), { recursive: true });

    const acquired = tryAcquireScopeLock({
      lockPath,
      hostIdentity: fixture.probe.hostIdentity,
    });
    expect(acquired).not.toBeNull();

    // 模拟 Broker 在持锁期间 spawn 出的长活用户 Writer。
    const userChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    childHandles.push(userChild);
    expect(isProcessAlive(userChild.pid as number)).toBe(true);

    const probeWhileHeld = await spawnNativeLockProbe(lockPath);
    expect(probeWhileHeld.state).toBe("busy");

    acquired?.release();

    // 子进程仍活着，但它没有继承锁 fd：锁必须立刻可被独立进程取得。
    expect(isProcessAlive(userChild.pid as number)).toBe(true);
    const probeAfterRelease = await spawnNativeLockProbe(lockPath);
    expect(probeAfterRelease.state).toBe("held");
    // 探测进程本身也持着锁：收掉它，才能观察真实 Broker 路径。
    process.kill(probeAfterRelease.pid, "SIGKILL");
    expect(await waitForProcessGone(probeAfterRelease.pid)).toBe(true);

    // 真实 Broker 路径同样能进入临界区（不是只对裸 provider 成立）。
    const grant = await activate(fixture, { operationId: "op-after-cloexec-probe" });
    expect(grant.writerGeneration).toBe(1);
  }, 30_000);

  /**
   * A07-T04：有可信来源的未确认 Writer 记录 + 指针已空 → 仍必须拒绝下一代。
   *
   * 这里不用手搓 JSON：`revokeWriterGeneration` 先制造真实的"受控停止边界"——
   * 父进程退出（登记过的进程组因此为空）、孙进程仍在写（写入活动不排空）。
   * 于是"进程组不存在"与"已确认停止"第一次成为两件不同的事实。
   */
  it("A07-T04 未知停止的更旧写者阻塞下一代：current 指针消失也不得绕过", async () => {
    const fixture = await setup();
    const grant = await activate(fixture);
    const writer = await spawnDetachedWriter(fixture, 1);

    const evidence = await fixture.broker.revokeWriterGeneration(revocationIdentity(grant));
    // 撤销是**逻辑**失效：登记的进程组确实空了，但写入活动没有排空，
    // 因此"已确认停止"不成立 —— 这两件事必须能分别被观察到。
    expect(evidence.stopped).toBe(false);
    expect(evidence.processGroupEmpty).toBe(true);
    expect(evidence.drained).toBe(false);
    expect(await pathExists(path.join(fixture.grantsRoot, "current.json"))).toBe(false);

    const blocked = await captureNotFenced(() =>
      activate(fixture, {
        writerGeneration: 2,
        authority: authority({
          ownershipId: "00000000-0000-4000-8000-0000000000b4",
          leaseEpoch: "2",
        }),
        operationId: "op-t04-next",
      }),
    );
    expect(blocked.detail).toMatch(/旧 Writer 进程组未确认停止/);
    expect(blocked.detail).toMatch(/generation 1/);

    // 旧定位保留，且没有 stopped/released 伪证。
    const record = JSON.parse(
      await readFile(
        path.join(fixture.writersDir, `${scopeComponent(fixture.probe.scopeDigest)}.1.json`),
        "utf8",
      ),
    ) as {
      pid: number | null;
      stop?: {
        confirmed: boolean;
        attempts: number;
        lastFailure: string | null;
        evidence: { stopped: boolean };
      };
    };
    expect(record.pid).not.toBeNull();
    expect(record.stop?.confirmed).toBe(false);
    expect(record.stop?.evidence.stopped).toBe(false);
    expect(record.stop?.lastFailure).toBeTruthy();
    const revocation = JSON.parse(
      await readFile(path.join(fixture.grantsRoot, "revoked", "1.json"), "utf8"),
    ) as { writerGeneration: number; evidence: { stopped: boolean } };
    expect(revocation.writerGeneration).toBe(1);
    expect(revocation.evidence.stopped).toBe(false);

    // 被拒绝的原因是真的：那个写者确实还在写工作区。
    const before = await activitySize(writer.activityPath);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await activitySize(writer.activityPath)).toBeGreaterThan(before ?? 0);
    expect(await fixture.broker.getWriter(fixture.probe.scopeDigest, 2)).toBeNull();

    // 操作者真正处置之后同一路径必须能继续（可重试，不是永久卡死）。
    killByPid(writer.childPid);
    expect(await waitForProcessGone(writer.childPid)).toBe(true);
    expect(await waitForActivityIdle(writer.activityPath)).toBe(true);
    const next = await activate(fixture, {
      writerGeneration: 2,
      authority: authority({
        ownershipId: "00000000-0000-4000-8000-0000000000b4",
        leaseEpoch: "2",
      }),
      operationId: "op-t04-next",
    });
    expect(next.writerGeneration).toBe(2);
    expect(next.oldWriterRevoked).toBe(true);
  }, 40_000);

  /**
   * A07-T08：停止失败**不删记录**，重试不能把"记录缺失"当成"已停止"。
   *
   * 负向对照：`rm(recordPath)` 无条件执行的实现，会在第一次失败后把定位抹掉，
   * 第二次调用就会看到一个"没有记录"的 generation 并返回 stopped = true ——
   * 那正是把真实写者当成不存在。
   */
  it("A07-T08 停止失败保留定位并真实重试：第三次确认停止才算 confirmed", async () => {
    const fixture = await setup();
    const grant = await activate(fixture);
    const writer = await spawnDetachedWriter(fixture, 1);
    const recordPath = path.join(
      fixture.writersDir,
      `${scopeComponent(fixture.probe.scopeDigest)}.1.json`,
    );
    const readRecord = async () =>
      JSON.parse(await readFile(recordPath, "utf8")) as {
        phase: string;
        pid: number | null;
        processGroupId: number | null;
        stop?: { confirmed: boolean; attempts: number; evidence: { stopped: boolean } };
      };

    const first = await fixture.broker.revokeWriterGeneration(revocationIdentity(grant));
    expect(first.stopped).toBe(false);
    expect((await readRecord()).stop?.attempts).toBe(1);

    // 第二次：重新检查、重新尝试；记录里仍是同一份进程组定位。
    const second = await fixture.broker.revokeWriterGeneration(revocationIdentity(grant));
    expect(second.stopped).toBe(false);
    const afterSecond = await readRecord();
    expect(afterSecond.stop?.attempts).toBe(2);
    expect(afterSecond.stop?.confirmed).toBe(false);
    expect(afterSecond.phase).toBe("running");
    expect(afterSecond.pid).not.toBeNull();
    expect(afterSecond.processGroupId).not.toBeNull();
    // 负向对照：无条件 `rm(recordPath)` 的行为在这里必然失败。
    expect(await pathExists(recordPath)).toBe(true);

    // 物理停止真正成立之后才允许 confirmed。
    killByPid(writer.childPid);
    expect(await waitForProcessGone(writer.childPid)).toBe(true);
    expect(await waitForActivityIdle(writer.activityPath)).toBe(true);
    const third = await fixture.broker.revokeWriterGeneration(revocationIdentity(grant));
    expect(third.stopped).toBe(true);
    expect(third.processGroupEmpty).toBe(true);
    expect(third.drained).toBe(true);
    const afterThird = await readRecord();
    expect(afterThird.stop?.confirmed).toBe(true);
    expect(afterThird.stop?.evidence.stopped).toBe(true);
    // 停止是幂等的物理事实：再取一次仍返回同一结论，不重复发信号。
    const fourth = await fixture.broker.revokeWriterGeneration(revocationIdentity(grant));
    expect(fourth.stopped).toBe(true);
    expect((await readRecord()).stop?.attempts).toBe(3);
  }, 40_000);

  /**
   * A07-T09：逻辑撤销立即禁用，但不伪造物理成功。
   *
   * 撤销必须两件事同时成立才算完整：旧 grant 的查询/授权/启动立即失效（墓碑），
   * 且**没有**被伪造成已停止（无 stopped 证据就不许新代际开始）。
   */
  it("A07-T09 逻辑撤销立即禁用旧授权，但不伪造物理成功", async () => {
    const fixture = await setup();
    const grant = await activate(fixture);
    const writer = await spawnDetachedWriter(fixture, 1);

    const evidence = await fixture.broker.revokeWriterGeneration(revocationIdentity(grant));
    expect(evidence.stopped).toBe(false);

    // 1) 旧写入授权立即拒绝（靠墓碑，不靠"进程看起来没了"）。
    await expect(
      fixture.broker.authorizeWrite({
        scopeDigest: fixture.probe.scopeDigest,
        writerGeneration: 1,
        ownershipId: authority().ownershipId,
      }),
    ).rejects.toThrow(WorkspaceWriterNotFencedError);
    // 2) 旧 grant 的查询与断言同样失效。
    expect(await fixture.broker.getWriter(fixture.probe.scopeDigest, 1)).toBeNull();
    await expect(fixture.broker.assertWriter(grant)).rejects.toThrow(WorkspaceWriterNotFencedError);
    // 3) 旧 generation 的受管启动被拒绝。
    await expect(spawnWriter(fixture, 1)).rejects.toThrow(WorkspaceWriterNotFencedError);
    // 4) 新激活也必须因"未停机"被拒绝 —— 墓碑不能替代停止证据。
    const blocked = await captureNotFenced(() =>
      activate(fixture, {
        writerGeneration: 2,
        authority: authority({
          ownershipId: "00000000-0000-4000-8000-0000000000b4",
          leaseEpoch: "2",
        }),
        operationId: "op-t09-next",
      }),
    );
    expect(blocked.detail).toMatch(/旧 Writer 进程组未确认停止/);
    // 5) 因此不存在两个可写者：没有任何 generation 能拿到授权。
    expect(await fixture.broker.getWriter(fixture.probe.scopeDigest, 2)).toBeNull();
    await expect(
      fixture.broker.authorizeWrite({
        scopeDigest: fixture.probe.scopeDigest,
        writerGeneration: 2,
        ownershipId: "00000000-0000-4000-8000-0000000000b4",
      }),
    ).rejects.toThrow(WorkspaceWriterNotFencedError);

    killByPid(writer.childPid);
    expect(await waitForProcessGone(writer.childPid)).toBe(true);
  }, 40_000);

  /**
   * A07-T14：历史激活回执不得复活写权。
   *
   * 回执是"那次激活成功过"的历史收据，不是"授权现在仍然有效"的证明。
   * 一旦被撤销、或当前授权指针已不属于该代际，重放必须拒绝而不是把写权发回去。
   */
  it("A07-T14 历史激活回执不复活已撤销代际，也不在指针被取代后发回写权", async () => {
    const fixture = await setup();
    await activate(fixture, { writerGeneration: 1, operationId: "op-old" });

    // 指针被更高代际取代：旧回执仍在盘上，但它不再代表任何授权。
    const newer = await activate(fixture, {
      writerGeneration: 2,
      authority: authority({
        ownershipId: "00000000-0000-4000-8000-0000000000b4",
        leaseEpoch: "2",
      }),
      operationId: "op-new",
    });
    expect(newer.writerGeneration).toBe(2);
    // 证明"完全相同的请求"确实会被旧实现当成合法重放：身份逐项一致。
    const stale = await captureNotFenced(() =>
      activate(fixture, { writerGeneration: 1, operationId: "op-old" }),
    );
    expect(stale.detail).toMatch(/当前授权指针不属于该代际/);
    expect(
      (await fixture.broker.getWriter(fixture.probe.scopeDigest, 1))?.writerGeneration,
    ).not.toBe(1);

    // A07 决策五（需求原句）：A 的激活成功后，B 的失败补偿**不得**只凭一个 generation
    // 数字就把 A 的健康 Writer 停掉。这里让 gen 2 真的有进程在写，再让一个**持有旧身份**
    // 的补偿方按同一个 generation 请求撤销。
    const healthyWriter = await spawnWriter(fixture, 2);
    expect(isProcessAlive(healthyWriter.pid)).toBe(true);
    const staleRevoke = await captureNotFenced(() =>
      fixture.broker.revokeWriterGeneration(
        revocationIdentity(newer, { ownershipId: authority().ownershipId }),
      ),
    );
    expect(staleRevoke.detail).toMatch(/精确身份与该代际的持久归属不一致/);
    // 负向对照：只按 generation 匹配的实现，这一步已经把 A 的进程组停掉了。
    expect(isProcessAlive(healthyWriter.pid)).toBe(true);
    expect((await fixture.broker.getWriter(fixture.probe.scopeDigest, 2))?.writerGeneration).toBe(
      2,
    );
    await expect(fixture.broker.assertWriter(newer)).resolves.toBeUndefined();
    // 也没有留下墓碑等任何"撤销已发生"的持久痕迹。
    expect(await pathExists(path.join(fixture.grantsRoot, "revoked", "2.json"))).toBe(false);

    // 已被撤销的代际：即使回执身份完全一致也不得发回写权。
    await fixture.broker.revokeWriterGeneration(revocationIdentity(newer));
    expect(await waitForProcessGone(healthyWriter.pid)).toBe(true);
    const revokedReplay = await captureNotFenced(() =>
      activate(fixture, {
        writerGeneration: 2,
        authority: authority({
          ownershipId: "00000000-0000-4000-8000-0000000000b4",
          leaseEpoch: "2",
        }),
        operationId: "op-new",
      }),
    );
    expect(revokedReplay.detail).toMatch(/已被撤销/);
    expect(await fixture.broker.getWriter(fixture.probe.scopeDigest, 2)).toBeNull();
  }, 30_000);

  /**
   * A07-T05：登记前 Broker 崩溃 → 用户任务**从未开始**。
   *
   * 真实独立 Broker 进程启动真实 wrapper 后不落定位，测试对它发真实 SIGKILL。
   * 私有启动通道的写端随进程关闭 → wrapper 读到 EOF → 退出，用户任务从未运行。
   * 负向对照：普通 `spawn` 直接执行用户命令的实现，这里必定已经写出 marker。
   */
  it("A07-T05 登记前 Broker 崩溃：用户任务从未开始，wrapper 自行退出", async () => {
    const fixture = await setup();
    const markerPath = path.join(fixture.writerRoot, "t05-marker.log");
    const recordPath = path.join(
      fixture.writersDir,
      `${scopeComponent(fixture.probe.scopeDigest)}.1.json`,
    );
    const probe = await startWriterBrokerProbe({
      mode: "pre-registration",
      hostRoot: fixture.hostRoot,
      managedRoot: fixture.writerRoot,
      writerRoot: fixture.runRoot,
      recordPath,
      markerPath,
      activityPath: markerPath,
      writerGeneration: 1,
    });
    externalHolderPids.push(probe.wrapperPid);

    // 窗口特征：wrapper 真实存活在等放行，但盘上**没有**定位记录。
    expect(isProcessAlive(probe.wrapperPid)).toBe(true);
    expect(await pathExists(recordPath)).toBe(false);
    expect(await pathExists(markerPath)).toBe(false);
    // 用户任务连"开始"都没有：给足时间也依然没有输出。
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await pathExists(markerPath)).toBe(false);

    // 真实 Broker 崩溃（没有任何 finally 会执行）。
    killByPid(probe.pid, "SIGKILL");
    expect(await waitForProcessGone(probe.pid)).toBe(true);
    // 屏障的结论：wrapper 因 EOF 退出，用户任务从未开始。
    expect(await waitForProcessGone(probe.wrapperPid)).toBe(true);
    expect(await pathExists(markerPath)).toBe(false);
    expect(await pathExists(recordPath)).toBe(false);

    // 负向对照：没有持久定位时，Broker **不能**声称自己停止过任何写者。
    const evidence = await fixture.broker.revokeWriterGeneration(probe.identity);
    expect(evidence.previousWriterPresent).toBe(false);
    expect(evidence.pids).toEqual([]);
  }, 40_000);

  /**
   * A07-T06：登记后、GO 前 Broker 崩溃 → 定位可回读，恢复方按记录定位并确认停止。
   *
   * 与 T05 的差别正是"定位是否落盘"：这里盘上有人可读的 containment identity，
   * 因此恢复方既能证明"曾经存在写者"，也能用记录里的进程组而不是猜 PID。
   */
  it("A07-T06 登记后 GO 前崩溃：定位可回读，恢复器不猜 PID 且不执行用户任务", async () => {
    const fixture = await setup();
    const markerPath = path.join(fixture.writerRoot, "t06-marker.log");
    const recordPath = path.join(
      fixture.writersDir,
      `${scopeComponent(fixture.probe.scopeDigest)}.1.json`,
    );
    const probe = await startWriterBrokerProbe({
      mode: "post-registration",
      hostRoot: fixture.hostRoot,
      managedRoot: fixture.writerRoot,
      writerRoot: fixture.runRoot,
      recordPath,
      markerPath,
      activityPath: markerPath,
      writerGeneration: 1,
    });
    externalHolderPids.push(probe.wrapperPid);

    // 定位已落盘且指向真实的 containment；用户任务仍未开始。
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      phase: string;
      pid: number | null;
      processGroupId: number | null;
      bootstrapToken: string | null;
      stop?: unknown;
    };
    expect(record.phase).toBe("running");
    expect(record.pid).toBe(probe.wrapperPid);
    expect(record.processGroupId).toBe(probe.wrapperPid);
    expect(record.bootstrapToken).toBe(probe.bootstrapToken);
    expect(record.stop).toBeUndefined();
    expect(isProcessAlive(probe.wrapperPid)).toBe(true);
    expect(await pathExists(markerPath)).toBe(false);

    killByPid(probe.pid, "SIGKILL");
    expect(await waitForProcessGone(probe.pid)).toBe(true);

    // 恢复：按记录定位（pids 来自记录本身，不是扫描同名进程）。
    const evidence = await fixture.broker.revokeWriterGeneration(probe.identity);
    expect(evidence.previousWriterPresent).toBe(true);
    expect(evidence.pids).toEqual([probe.wrapperPid]);
    expect(evidence.stopped).toBe(true);
    expect(evidence.processGroupEmpty).toBe(true);
    expect(await waitForProcessGone(probe.wrapperPid)).toBe(true);
    // 屏障的结论不依赖"Broker 是否来得及回来"：用户任务从未开始。
    expect(await pathExists(markerPath)).toBe(false);
  }, 40_000);

  /**
   * A07-T07：GO 后 Broker 崩溃 → 实际运行处在已登记的 containment 中，可被真实停止并排空。
   *
   * 负向对照：只写 `phase = spawning` 而没有 PID 登记的实现在这里无法停止真实写者。
   */
  it("A07-T07 GO 后崩溃：已登记 containment 中的真实写者被停止并排空", async () => {
    const fixture = await setup();
    const markerPath = path.join(fixture.writerRoot, "t07-marker.log");
    const recordPath = path.join(
      fixture.writersDir,
      `${scopeComponent(fixture.probe.scopeDigest)}.1.json`,
    );
    const probe = await startWriterBrokerProbe({
      mode: "released",
      hostRoot: fixture.hostRoot,
      managedRoot: fixture.writerRoot,
      writerRoot: fixture.runRoot,
      recordPath,
      markerPath,
      activityPath: markerPath,
      writerGeneration: 1,
    });
    externalHolderPids.push(probe.wrapperPid);

    // 放行后用户任务真的在写工作区。
    expect(await waitForFileExists(markerPath)).toBe(true);
    expect(await fileStillGrowing(markerPath)).toBe(true);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      pid: number | null;
      processGroupId: number | null;
      stop?: unknown;
    };
    expect(record.processGroupId).toBe(probe.wrapperPid);
    expect(record.stop).toBeUndefined();

    killByPid(probe.pid, "SIGKILL");
    expect(await waitForProcessGone(probe.pid)).toBe(true);
    // Broker 不在了，但真实写者还在写 —— 这正是"必须能定位并停止"的对象。
    expect(isProcessAlive(probe.wrapperPid)).toBe(true);
    expect(await fileStillGrowing(markerPath)).toBe(true);

    const evidence = await fixture.broker.revokeWriterGeneration(probe.identity);
    expect(evidence.previousWriterPresent).toBe(true);
    expect(evidence.stopped).toBe(true);
    expect(evidence.processGroupEmpty).toBe(true);
    expect(evidence.drained).toBe(true);
    expect(evidence.pids).toEqual([probe.wrapperPid]);
    // 停止与排空都成立之后，工作区不再被旧写者继续修改。
    expect(await waitForProcessGone(probe.wrapperPid)).toBe(true);
    expect(await waitForActivityIdle(markerPath)).toBe(true);
    const after = JSON.parse(await readFile(recordPath, "utf8")) as {
      stop?: { confirmed: boolean; evidence: { stopped: boolean } };
    };
    expect(after.stop?.confirmed).toBe(true);
    expect(after.stop?.evidence.stopped).toBe(true);
  }, 40_000);

  /**
   * A07-T13 / A07-07：冻结与新的受管写入并发 —— 屏障必须在**锁内**生效，文件 IO 不能
   * "先拿可写路径、稍后再写"。
   *
   * 这一条针对的正是 `authorizeWrite` 单独无法覆盖的窗口：调用方已经拿到可写根，冻结随后
   * 才落盘。负向对照是"授权通过 = 之后随便写"的实现 —— 那样本用例里交错的受管写会成功。
   */
  it("A07-T13 冻结与受管写入并发：锁内复核生效，解冻后恢复，旧 release 不解新 intent", async () => {
    const fixture = await setup();
    const grant = await activate(fixture);
    const identity = revocationIdentity(grant);
    const writer = await spawnWriter(fixture);
    const activityPath = path.join(fixture.writerRoot, "writer-activity-1.log");

    // ① 正常路径：受管写在锁内完成并真的落盘，目标路径在受管根内。
    const okWrite = await fixture.broker.executeManagedFileOperation({
      identity,
      operation: { kind: "write", path: "notes/one.txt", content: "before-freeze" },
    });
    expect(okWrite.kind).toBe("write");
    // 受管根是 realpath 后的真实路径（macOS 的 /var → /private/var 必须被消掉），
    // 因此断言"落在受管根内的同一位置"，而不是拼一个未解析的字符串。
    expect(okWrite.path).toBe(await realpath(path.join(fixture.runRoot, "notes", "one.txt")));
    expect(await readFile(okWrite.path, "utf8")).toBe("before-freeze");

    // ② "文件能力"不能变成写根外的东西：越界路径直接拒绝。
    await expect(
      fixture.broker.executeManagedFileOperation({
        identity,
        operation: { kind: "write", path: "../escape.txt", content: "x" },
      }),
    ).rejects.toThrow(WorkspaceWriterNotFencedError);
    expect(await pathExists(path.join(fixture.writerRoot, "escape.txt"))).toBe(false);

    // ③ 陈旧身份（同 generation、换 Ownership）不得写：精确归属才是授权单位。
    const staleIdentity = {
      ...identity,
      ownershipId: "00000000-0000-4000-8000-0000000000b4",
    };
    await expect(
      fixture.broker.executeManagedFileOperation({
        identity: staleIdentity,
        operation: { kind: "write", path: "notes/stale.txt", content: "x" },
      }),
    ).rejects.toThrow(WorkspaceWriterNotFencedError);
    expect(await pathExists(path.join(fixture.runRoot, "notes", "stale.txt"))).toBe(false);

    // ④ 先拿到"可写授权"，再冻结：交错下来的那次受管写必须 fail closed。
    await expect(
      fixture.broker.authorizeWrite({
        scopeDigest: fixture.probe.scopeDigest,
        writerGeneration: 1,
        ownershipId: identity.ownershipId,
      }),
    ).resolves.toMatchObject({ writerGeneration: 1 });

    const receiptA = await fixture.broker.freeze({
      grant,
      checkpointIntentId: INTENT_ID,
      anchorDigest: ANCHOR_DIGEST,
    });
    // 冻结是物理事实：已登记的真实 Writer 被停止并排空，屏障期间不再有新增写入。
    expect(await waitForProcessGone(writer.pid)).toBe(true);
    expect(await waitForActivityIdle(activityPath)).toBe(true);

    const duringFreeze = await captureNotFenced(() =>
      fixture.broker.executeManagedFileOperation({
        identity,
        operation: { kind: "write", path: "notes/two.txt", content: "during-freeze" },
      }),
    );
    expect(duringFreeze.detail).toMatch(/冻结/);
    expect(await pathExists(path.join(fixture.runRoot, "notes", "two.txt"))).toBe(false);
    // 授权出口同样 fail closed —— 屏障不能只靠"冻结那一刻把 Writer 停了"。
    const authDuringFreeze = await captureNotFenced(() =>
      fixture.broker.authorizeWrite({
        scopeDigest: fixture.probe.scopeDigest,
        writerGeneration: 1,
        ownershipId: identity.ownershipId,
      }),
    );
    expect(authDuringFreeze.detail).toMatch(/冻结/);

    // ⑤ 屏障存在期间的文件扫描必须一致（没有任何新写者产生新文件）。
    const scanWhileFrozen = await scanTree(fixture.runRoot);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await scanTree(fixture.runRoot)).toEqual(scanWhileFrozen);

    // ⑥ 迟到的旧 release 不得解掉新 intent。
    const receiptB = await fixture.broker.freeze({
      grant,
      checkpointIntentId: "00000000-0000-4000-8000-0000000000f2",
      anchorDigest: ANCHOR_DIGEST,
    });
    await fixture.broker.releaseFreeze(receiptA);
    const staleReleaseWrite = await captureNotFenced(() =>
      fixture.broker.executeManagedFileOperation({
        identity,
        operation: { kind: "write", path: "notes/three.txt", content: "stale-release" },
      }),
    );
    expect(staleReleaseWrite.detail).toMatch(/冻结/);
    expect(await pathExists(path.join(fixture.runRoot, "notes", "three.txt"))).toBe(false);

    // ⑦ 解掉**当前** intent 之后，合法受管写入恢复（屏障不是永久锁死）。
    await fixture.broker.releaseFreeze(receiptB);
    const afterRelease = await fixture.broker.executeManagedFileOperation({
      identity,
      operation: { kind: "write", path: "notes/three.txt", content: "after-release" },
    });
    expect(await readFile(afterRelease.path, "utf8")).toBe("after-release");

    // ⑧ 受管删除同样走这条唯一入口。
    const removed = await fixture.broker.executeManagedFileOperation({
      identity,
      operation: { kind: "delete", path: "notes/three.txt" },
    });
    expect(removed.kind).toBe("delete");
    expect(await pathExists(afterRelease.path)).toBe(false);
  }, 40_000);
});

/**
/**
 * 起一个真实**第二进程**，用原生 provider 在同一个稳定锁文件上尝试取锁。
 *
 * 这是"真实 provider + 真实不同进程"的观察点：不注入 proc-a/proc-b 字符串，
 * 也不在内存 mutex 上自证。
 */
async function spawnNativeLockProbe(
  lockPath: string,
): Promise<{ state: "held" | "busy"; pid: number }> {
  const script = `
    const { createRequire } = require("node:module");
    const dir = process.argv[1];
    const lockPath = process.argv[2];
    const native = createRequire(dir + "/index.cjs")(dir);
    const result = native.openAndTryLock(lockPath);
    process.stdout.write(JSON.stringify({ state: result.state }) + "\\n");
    if (result.state === "held") setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script, NATIVE_MODULE_DIR, lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  externalHolderPids.push(child.pid as number);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // `busy` 的子进程会立刻退出，`held` 的会常驻：两者都必须先把 state 写出来。
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`锁探测子进程 5s 内既未输出也未退出（stderr=${stderr || "<empty>"}）`));
    }, 5_000);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", () => {
      if (stdout.includes("\n")) settle();
    });
    child.on("exit", () => settle());
  });
  const line = stdout.split("\n")[0]?.trim() ?? "";
  if (!line) throw new Error(`锁探测子进程未输出 state（stderr=${stderr || "<empty>"}）`);
  const parsed = JSON.parse(line) as { state: "held" | "busy" };
  return { state: parsed.state, pid: child.pid as number };
}

/** 同 `spawnNativeLockProbe`，但要求**必须取得**锁（否则说明锁没被正确释放）。 */
async function spawnNativeLockHolder(lockPath: string) {
  const probe = await spawnNativeLockProbe(lockPath);
  if (probe.state !== "held") {
    throw new Error(`外部持有者未取得锁（state=${probe.state}）：${lockPath}`);
  }
  return probe;
}
