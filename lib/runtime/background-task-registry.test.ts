import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { BackgroundTask } from "@/lib/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.2 Stage A：BackgroundTask registry 单测。
 * 用内存 Map 模拟 DB 行为，断言 registerStart / markRunning / markStopped /
 * stopAllByThread / markOrphansOnStartup / readTaskLogs 的状态流转与事件追加。
 */

const store = new Map<string, BackgroundTask>();
const events: Array<{ threadId: string; type: string; payload: Record<string, unknown> }> = [];

const queries = vi.hoisted(() => ({
  createBackgroundTask: vi.fn(),
  getBackgroundTask: vi.fn(),
  updateBackgroundTask: vi.fn(),
  listActiveBackgroundTasksByThread: vi.fn(),
  listBackgroundTasksByThread: vi.fn(),
  listActiveBackgroundTasks: vi.fn(),
  markOrphanBackgroundTasksOnStartup: vi.fn(),
  appendThreadEvent: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  createBackgroundTask: queries.createBackgroundTask,
  getBackgroundTask: queries.getBackgroundTask,
  updateBackgroundTask: queries.updateBackgroundTask,
  listActiveBackgroundTasksByThread: queries.listActiveBackgroundTasksByThread,
  listBackgroundTasksByThread: queries.listBackgroundTasksByThread,
  listActiveBackgroundTasks: queries.listActiveBackgroundTasks,
  markOrphanBackgroundTasksOnStartup: queries.markOrphanBackgroundTasksOnStartup,
  appendThreadEvent: queries.appendThreadEvent,
}));

import {
  __clearBackgroundTaskRegistryForTest,
  attachStopHandle,
  listByThread,
  markOrphansOnStartup,
  markRunning,
  markStopped,
  readTaskLogs,
  registerStart,
  resolveAbsLogPath,
  stopAllByThread,
} from "./background-task-registry";

let dir: string;
const origHostLogDir = process.env.SNOW_BG_TASK_HOST_LOG_DIR;

function row(overrides: Partial<BackgroundTask>): BackgroundTask {
  const now = new Date();
  return {
    id: "task-1",
    threadId: "t1",
    toolRunId: null,
    kind: "dev-server",
    command: "npm run dev",
    runtimeType: "host",
    status: "starting",
    pid: null,
    containerName: null,
    port: null,
    logPath: "",
    exitCode: null,
    startedAt: now,
    finishedAt: null,
    lastActivityAt: now,
    ...overrides,
  } as BackgroundTask;
}

beforeEach(async () => {
  store.clear();
  events.length = 0;
  __clearBackgroundTaskRegistryForTest();
  dir = await mkdtemp(join(tmpdir(), "snow-bg-registry-"));
  process.env.SNOW_BG_TASK_HOST_LOG_DIR = dir;

  queries.createBackgroundTask.mockImplementation(async (params: Record<string, unknown>) => {
    const r = row({
      id: `task-${store.size + 1}`,
      threadId: params.threadId as string,
      kind: params.kind as BackgroundTask["kind"],
      command: params.command as string,
      runtimeType: params.runtimeType as string,
      logPath: "",
      port: (params.port as number | null) ?? null,
    });
    store.set(r.id, r);
    return r;
  });
  queries.getBackgroundTask.mockImplementation(async (id: string) => store.get(id) ?? null);
  queries.updateBackgroundTask.mockImplementation(
    async (id: string, patch: Record<string, unknown>) => {
      const ex = store.get(id);
      if (!ex) return null;
      const merged = {
        ...ex,
        ...patch,
        lastActivityAt: (patch.lastActivityAt as Date) ?? new Date(),
      };
      store.set(id, merged);
      return merged;
    },
  );
  queries.listActiveBackgroundTasksByThread.mockImplementation(async (threadId: string) =>
    [...store.values()].filter(
      (t) => t.threadId === threadId && (t.status === "starting" || t.status === "running"),
    ),
  );
  queries.listBackgroundTasksByThread.mockImplementation(async (threadId: string) =>
    [...store.values()].filter((t) => t.threadId === threadId),
  );
  queries.listActiveBackgroundTasks.mockImplementation(async () =>
    [...store.values()].filter((t) => t.status === "starting" || t.status === "running"),
  );
  queries.markOrphanBackgroundTasksOnStartup.mockImplementation(async () => {
    const now = new Date();
    const out: BackgroundTask[] = [];
    for (const t of store.values()) {
      if (t.status === "starting" || t.status === "running") {
        const o = { ...t, status: "orphaned" as const, finishedAt: now, lastActivityAt: now };
        store.set(t.id, o);
        out.push(o);
      }
    }
    return out;
  });
  queries.appendThreadEvent.mockImplementation(
    async (threadId: string, type: string, payload: Record<string, unknown>) => {
      events.push({ threadId, type, payload });
      return {
        id: `e${events.length}`,
        threadId,
        sequence: events.length,
        type,
        payload,
        createdAt: new Date(),
      };
    },
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  if (origHostLogDir === undefined) delete process.env.SNOW_BG_TASK_HOST_LOG_DIR;
  else process.env.SNOW_BG_TASK_HOST_LOG_DIR = origHostLogDir;
});

describe("registerStart", () => {
  it("写 starting 行 + 回填 logPath + 创建空日志文件", async () => {
    const { taskId, logPath } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    expect(taskId).toBeTruthy();
    expect(logPath).toBe([".snow", "runtime", "t1", "tasks", `${taskId}.log`].join(sep));
    const stored = store.get(taskId);
    expect(stored?.status).toBe("starting");
    expect(stored?.logPath).toBe(logPath);
    // 日志文件已创建
    const abs = resolveAbsLogPath("host", "t1", taskId);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(abs, "utf8")).toBe("");
  });

  it("container 模式日志落 workspace bind mount", async () => {
    process.env.SNOW_WORKSPACES_DIR = dir;
    const { taskId } = await registerStart({
      threadId: "tC",
      kind: "watcher",
      command: "vite",
      runtimeType: "container",
    });
    const abs = resolveAbsLogPath("container", "tC", taskId);
    expect(abs.startsWith(resolve(dir, "tC"))).toBe(true);
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.SNOW_WORKSPACES_DIR;
  });
});

describe("markRunning", () => {
  it("置 running + 回填 pid + 写 task.started 事件", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    const updated = await markRunning(taskId, { pid: 12345, port: 41000 });
    expect(updated?.status).toBe("running");
    expect(updated?.pid).toBe(12345);
    expect(updated?.port).toBe(41000);
    expect(events.find((e) => e.type === "task.started")?.payload).toMatchObject({
      taskId,
      kind: "dev-server",
      pid: 12345,
      port: 41000,
    });
  });
});

describe("markStopped", () => {
  it("reason=manual → stopped + task.stopped，清 handle", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    const stopped = await markStopped(taskId, { exitCode: 0, reason: "manual" });
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.exitCode).toBe(0);
    expect(stopped?.finishedAt).toBeInstanceOf(Date);
    expect(events.find((e) => e.type === "task.stopped")?.payload).toMatchObject({
      taskId,
      exitCode: 0,
      reason: "manual",
    });
    expect(events.find((e) => e.type === "task.failed")).toBeUndefined();
  });

  it("reason=crash → failed + task.failed", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "worker",
      command: "node worker.js",
      runtimeType: "host",
    });
    const stopped = await markStopped(taskId, { exitCode: 1, reason: "crash", error: "boom" });
    expect(stopped?.status).toBe("failed");
    expect(events.find((e) => e.type === "task.failed")?.payload).toMatchObject({
      taskId,
      reason: "crash",
      error: "boom",
    });
  });

  it("attachStopHandle 注入的 stop 回调在 markStopped 时被调用", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    attachStopHandle(taskId, stop);
    await markStopped(taskId, { reason: "manual" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stop 回调抛错不掩盖终止标记", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    attachStopHandle(taskId, vi.fn().mockRejectedValue(new Error("kill fail")));
    const stopped = await markStopped(taskId, { reason: "manual" });
    expect(stopped?.status).toBe("stopped");
  });

  // S1（02-P2-9）：attachStopHandle threadId 校验——跨 thread 误注入被拒,防全局 Map 串台。
  it("attachStopHandle 传错误 threadId → 拒绝注入(stop 回调不被设置)", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    // t1 的任务,用 t2 身份注入 → 拒绝
    attachStopHandle(taskId, stop, "t2");
    await markStopped(taskId, { reason: "manual" });
    // stop 未被调用(注入被拒)
    expect(stop).not.toHaveBeenCalled();
  });

  it("attachStopHandle 传正确 threadId → 允许注入", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    attachStopHandle(taskId, stop, "t1");
    await markStopped(taskId, { reason: "manual" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("attachStopHandle 不传 threadId → 保持原行为(向后兼容,不校验)", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    attachStopHandle(taskId, stop); // 不传 threadId
    await markStopped(taskId, { reason: "manual" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("任务不存在 → 返回 null，不抛", async () => {
    const stopped = await markStopped("ghost", { reason: "manual" });
    expect(stopped).toBeNull();
  });
});

describe("stopAllByThread", () => {
  it("逐个停止 thread 下 active 任务（thread_end）", async () => {
    const a = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "a",
      runtimeType: "host",
    });
    const b = await registerStart({
      threadId: "t1",
      kind: "watcher",
      command: "b",
      runtimeType: "host",
    });
    // 另一 thread 的任务不应被停
    await registerStart({ threadId: "t2", kind: "dev-server", command: "c", runtimeType: "host" });

    await stopAllByThread("t1", "thread_end");

    expect(store.get(a.taskId)?.status).toBe("stopped");
    expect(store.get(b.taskId)?.status).toBe("stopped");
    expect([...store.values()].filter((t) => t.threadId === "t2")[0]?.status).toBe("starting");
    const stoppedEvents = events.filter((e) => e.type === "task.stopped");
    expect(stoppedEvents).toHaveLength(2);
    expect(stoppedEvents.every((e) => e.payload.reason === "thread_end")).toBe(true);
  });
});

describe("listByThread", () => {
  it("列 thread 全部任务", async () => {
    await registerStart({ threadId: "t1", kind: "dev-server", command: "a", runtimeType: "host" });
    await registerStart({ threadId: "t1", kind: "worker", command: "b", runtimeType: "host" });
    const list = await listByThread("t1");
    expect(list).toHaveLength(2);
  });
});

describe("markOrphansOnStartup", () => {
  it("把 starting/running 行标 orphaned，不假装存活", async () => {
    const a = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "a",
      runtimeType: "host",
    });
    await markRunning(a.taskId, { pid: 999 });
    // 模拟进程重启：清进程内 Map（旧 pid 失效）
    __clearBackgroundTaskRegistryForTest();

    const orphans = await markOrphansOnStartup();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.status).toBe("orphaned");
    expect(store.get(a.taskId)?.status).toBe("orphaned");
  });

  it("无 active 任务 → 空数组", async () => {
    const orphans = await markOrphansOnStartup();
    expect(orphans).toEqual([]);
  });

  // 02-P1-5：host 态孤儿 pid 存活 → kill(pid,0) 返回正常 → 发 SIGTERM（防资源泄漏）
  it("host 态孤儿 pid 存活（kill(pid,0) 不抛）→ 发 SIGTERM", async () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const a = await registerStart({
      threadId: "t-sigterm",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    await markRunning(a.taskId, { pid: 4242 });
    __clearBackgroundTaskRegistryForTest();

    await markOrphansOnStartup();

    // 探活 kill(pid, 0) + 发送 kill(pid, "SIGTERM") 两次调用
    expect(killSpy).toHaveBeenCalledWith(4242, 0);
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    // 状态仍标 orphaned（SIGTERM 是 best-effort，不改变 DB 状态机）
    expect(store.get(a.taskId)?.status).toBe("orphaned");
    killSpy.mockRestore();
  });

  // 02-P1-5：pid 不存在 → kill(pid,0) 抛 ESRCH → 不发 SIGTERM，只标记 orphaned
  it("host 态孤儿 pid 已死（kill(pid,0) 抛 ESRCH）→ 不发 SIGTERM，只标 orphaned", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      // 模拟 ESRCH：pid 不存在
      const err = new Error("kill ESRCH");
      (err as NodeJS.ErrnoException).code = "ESRCH";
      throw err;
    });
    const a = await registerStart({
      threadId: "t-dead",
      kind: "worker",
      command: "node worker.js",
      runtimeType: "host",
    });
    await markRunning(a.taskId, { pid: 7777 });
    __clearBackgroundTaskRegistryForTest();

    await markOrphansOnStartup();

    // 只调了探活 kill(pid, 0)，未发 SIGTERM
    expect(killSpy).toHaveBeenCalledWith(7777, 0);
    expect(killSpy).not.toHaveBeenCalledWith(7777, "SIGTERM");
    expect(store.get(a.taskId)?.status).toBe("orphaned");
    killSpy.mockRestore();
  });

  // 02-P1-5：容器态 pid 在容器内，host kill 无效，不发 SIGTERM
  it("container 态孤儿 pid → 不发 SIGTERM（host kill 对容器内进程无效）", async () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const a = await registerStart({
      threadId: "t-container",
      kind: "dev-server",
      command: "vite",
      runtimeType: "container",
    });
    await markRunning(a.taskId, { pid: 8888 });
    __clearBackgroundTaskRegistryForTest();

    await markOrphansOnStartup();

    // container 态不发 host kill（探活与 SIGTERM 都不发）
    expect(killSpy).not.toHaveBeenCalled();
    expect(store.get(a.taskId)?.status).toBe("orphaned");
    killSpy.mockRestore();
  });
});

describe("readTaskLogs", () => {
  it("按 runtimeType 解析路径并读取限长片段", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    const abs = resolveAbsLogPath("host", "t1", taskId);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(abs, "line1\nline2\nline3\n");

    const r = await readTaskLogs(taskId, { offset: 0 });
    expect(r?.content).toBe("line1\nline2\nline3\n");
    expect(r?.totalBytes).toBe(18);
    expect(r?.truncated).toBe(false);
  });

  it("任务不存在 → null", async () => {
    const r = await readTaskLogs("ghost");
    expect(r).toBeNull();
  });

  it("tail 读取", async () => {
    const { taskId } = await registerStart({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
    });
    const abs = resolveAbsLogPath("host", "t1", taskId);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(abs, "0123456789");
    const r = await readTaskLogs(taskId, { tail: 3 });
    expect(r?.content).toBe("789");
  });
});
