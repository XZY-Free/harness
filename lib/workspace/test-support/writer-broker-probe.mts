/**
 * A07 决策三的**真实 Broker 进程**探针（测试支持，不是生产入口）。
 *
 * 三个崩溃窗口无法在单进程测试内被真实触发（测试进程必须活着观察结果），
 * 因此这里起一个独立进程模拟 Broker，由测试在选定时刻真实 SIGKILL 它。
 *
 * 它调用的**全部**是生产代码：`WorkspaceHostBroker.activateWriter`、
 * `launchManagedWriterProcess`、`writeManagedWriterContainment`、`spawnManagedWriter`
 * 与 `continuousWriterArgs`。探针只决定"在哪一步停住不再往下走"，不伪造任何持久事实。
 *
 * 用法：node --import tsx writer-broker-probe.mts '<config json>'
 *
 * config：
 * - `pre-registration`：启动 wrapper 后**不落定位**（② 之后、③ 之前）
 * - `post-registration`：落定位后**不放行**（③ 之后、④ 之前）
 * - `released`：完整 `spawnManagedWriter`（④ 之后）
 */
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import type { WorkspaceWriterIdentity } from "@/lib/workspace/workspace-host";
import {
  continuousWriterArgs,
  createWorkspaceHostBroker,
} from "@/lib/workspace/workspace-host-server";
import {
  launchManagedWriterProcess,
  writeManagedWriterContainment,
} from "@/lib/workspace/writer-launcher";

interface ProbeConfig {
  mode: "pre-registration" | "post-registration" | "released";
  hostRoot: string;
  managedRoot: string;
  writerRoot: string;
  recordPath: string;
  markerPath: string;
  activityPath: string;
  writerGeneration: number;
}

const config = JSON.parse(process.argv[2] ?? "{}") as ProbeConfig;

const PROBE_TENANT_ID = "00000000-0000-4000-8000-000000000000";
const PROBE_AUTHORITY = {
  invocationId: "00000000-0000-4000-8000-0000000000a1",
  runtimeRevisionId: "00000000-0000-4000-8000-0000000000a2",
  attemptId: "00000000-0000-4000-8000-0000000000a3",
  ownershipId: "00000000-0000-4000-8000-0000000000a4",
  leaseEpoch: "1",
  sessionBindingId: "00000000-0000-4000-8000-0000000000a5",
} satisfies AuthorityIdentity;

/** 用户任务：先留下"我运行过"的标记，再持续写入（这样恢复方有真实进程可停）。 */
function userWriterArgs(): string[] {
  return continuousWriterArgs({
    targetFile: config.markerPath,
    payload: `user-task:${config.mode}`,
  });
}

async function main(): Promise<void> {
  await mkdir(config.hostRoot, { recursive: true });
  await mkdir(config.managedRoot, { recursive: true });
  const broker = createWorkspaceHostBroker({
    root: config.hostRoot,
    managedRoot: config.managedRoot,
  });
  const probe = await broker.probeIdentity();
  const operationId = `probe-activate:${config.mode}`;
  await broker.activateWriter({
    tenantId: PROBE_TENANT_ID,
    scopeDigest: probe.scopeDigest,
    writerGeneration: config.writerGeneration,
    authority: PROBE_AUTHORITY,
    expectedStorageIdentity: probe.storageIdentity,
    operationId,
    root: config.writerRoot,
  });
  // A07 决策五：本进程就是这次激活的调用方，因此由它交出**精确归属身份**。
  // 测试据此请求撤销；自己拼一个 generation 数字在契约上已经不可表达。
  const identity: WorkspaceWriterIdentity = {
    tenantId: PROBE_TENANT_ID,
    scopeDigest: probe.scopeDigest,
    writerGeneration: config.writerGeneration,
    invocationId: PROBE_AUTHORITY.invocationId,
    attemptId: PROBE_AUTHORITY.attemptId,
    ownershipId: PROBE_AUTHORITY.ownershipId,
    operationId,
  };

  if (config.mode === "released") {
    const spawned = await broker.spawnManagedWriter({
      tenantId: PROBE_TENANT_ID,
      scopeDigest: probe.scopeDigest,
      writerGeneration: config.writerGeneration,
      command: process.execPath,
      args: userWriterArgs(),
      cwd: config.writerRoot,
      activityPath: config.activityPath,
    });
    process.stdout.write(
      `${JSON.stringify({
        wrapperPid: spawned.processGroupId,
        scopeDigest: probe.scopeDigest,
        mode: config.mode,
        identity,
      })}\n`,
    );
    return;
  }

  const launched = launchManagedWriterProcess({
    command: process.execPath,
    args: userWriterArgs(),
    cwd: config.writerRoot,
    scopeDigest: probe.scopeDigest,
    writerGeneration: config.writerGeneration,
  });
  if (config.mode === "post-registration") {
    await writeManagedWriterContainment(config.recordPath, {
      scopeDigest: probe.scopeDigest,
      writerGeneration: config.writerGeneration,
      phase: "running",
      pid: launched.pid,
      processGroupId: launched.processGroupId,
      bootstrapToken: launched.bootstrapToken,
      command: `${process.execPath} ${userWriterArgs().join(" ")}`,
      activityPath: config.activityPath,
      registeredAt: new Date().toISOString(),
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      wrapperPid: launched.pid,
      bootstrapToken: launched.bootstrapToken,
      scopeDigest: probe.scopeDigest,
      mode: config.mode,
      identity,
      controlRoot: path.join(await realpath(config.hostRoot), ".snow"),
    })}\n`,
  );
}

void main();
setInterval(() => {}, 1_000);
