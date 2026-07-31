import type { BackgroundTask } from "@/lib/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.2 Stage C：后台任务四件套单测。
 * 直接测 buildCommandTaskTools 返回的 tool.execute（经 executeToolRun 包裹）。
 * 覆盖：start 立即返回 taskId 不阻塞、owner scope 校验、read 限长透传、list 返回。
 */

const TID = "test-command-tasks";

const queryMocks = vi.hoisted(() => ({
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  requestApprovalAtomic: vi.fn(),
}));
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: vi.fn(),
  updateThreadPreviewUrl: vi.fn(),
  updateThreadStatus: vi.fn(),
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  requestApprovalAtomic: queryMocks.requestApprovalAtomic,
}));

const registry = vi.hoisted(() => ({
  registerStart: vi.fn(),
  markRunning: vi.fn(),
  markStopped: vi.fn(),
  getTask: vi.fn(),
  listByThread: vi.fn(),
  readTaskLogs: vi.fn(),
  closeAllBackgroundTasks: vi.fn().mockResolvedValue(undefined),
  sweepIdleBackgroundTasks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/runtime/background-task-registry", () => ({
  registerStart: registry.registerStart,
  markRunning: registry.markRunning,
  markStopped: registry.markStopped,
  getTask: registry.getTask,
  listByThread: registry.listByThread,
  readTaskLogs: registry.readTaskLogs,
  closeAllBackgroundTasks: registry.closeAllBackgroundTasks,
  sweepIdleBackgroundTasks: registry.sweepIdleBackgroundTasks,
}));

import { buildCommandTaskTools } from "./command-tasks";

/** 构造一个 fake runtime handle，execution 带 startBackground/stopBackground spy。 */
function makeRuntime(
  startBackground: (cmd: string, opts: unknown) => Promise<unknown>,
  stopBackground: (h: unknown) => Promise<void>,
) {
  return {
    workspace: {},
    preview: {},
    execution: { startBackground, stopBackground, exec: vi.fn() },
  } as unknown as Parameters<typeof buildCommandTaskTools>[1];
}

type ToolLike = { execute?: (...args: never[]) => unknown };
function callExecute(tool: ToolLike, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return Promise.resolve(tool.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.createToolRun.mockResolvedValue({ id: "run-1", threadId: TID, status: "running" });
  queryMocks.appendThreadEvent.mockResolvedValue({});
  queryMocks.finishToolRunSuccess.mockResolvedValue(undefined);
  queryMocks.finishToolRunFailure.mockResolvedValue(undefined);
  // 模拟 DB 有一条高优先级 allow 规则覆盖 startBackgroundTask 的默认 ask 规则
  queryMocks.listPermissionRules.mockResolvedValue([
    {
      id: "test:allow:sbt",
      scope: "global",
      scopeRef: null,
      toolPattern: "tool.startBackgroundTask",
      argMatcher: null,
      decision: "allow",
      reason: "test-allow",
      priority: 200,
    },
  ]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startBackgroundTask", () => {
  it("registerStart → startBackground → markRunning，立即返回 taskId 不阻塞", async () => {
    registry.registerStart.mockResolvedValue({
      taskId: "bt1",
      logPath: ".snow/runtime/t/tasks/bt1.log",
    });
    const startBackground = vi.fn().mockResolvedValue({ pid: 12345, command: "npm run dev" });
    const stopBackground = vi.fn().mockResolvedValue(undefined);
    const tools = buildCommandTaskTools(TID, makeRuntime(startBackground, stopBackground), "host");
    const r = await callExecute(tools.startBackgroundTask, { command: "npm run dev" });
    expect(r).toMatchObject({ ok: true, taskId: "bt1", kind: "custom", runtimeType: "host" });
    expect(registry.registerStart).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: TID, command: "npm run dev", runtimeType: "host" }),
    );
    expect(startBackground).toHaveBeenCalledWith(
      "npm run dev",
      expect.objectContaining({ taskId: "bt1", threadId: TID }),
    );
    expect(registry.markRunning).toHaveBeenCalledWith("bt1", {
      pid: 12345,
      containerName: undefined,
    });
  });

  it("kind 透传", async () => {
    registry.registerStart.mockResolvedValue({ taskId: "bt2", logPath: "x" });
    const startBackground = vi.fn().mockResolvedValue({ pid: 1, command: "vite" });
    const tools = buildCommandTaskTools(TID, makeRuntime(startBackground, vi.fn()), "host");
    const r = await callExecute(tools.startBackgroundTask, { command: "vite", kind: "watcher" });
    expect(r).toMatchObject({ kind: "watcher" });
    expect(registry.registerStart).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "watcher" }),
    );
  });

  it("经 executeToolRun 落 tool.called/tool.succeeded 事件", async () => {
    registry.registerStart.mockResolvedValue({ taskId: "bt3", logPath: "x" });
    const startBackground = vi.fn().mockResolvedValue({ pid: 1, command: "x" });
    const tools = buildCommandTaskTools(TID, makeRuntime(startBackground, vi.fn()), "host");
    await callExecute(tools.startBackgroundTask, { command: "x" });
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.succeeded");
    expect(queryMocks.finishToolRunSuccess).toHaveBeenCalled();
  });
});

describe("readTaskLogs owner scope + 限长透传", () => {
  it("本 thread 任务 → 透传 readTaskLogs 结果", async () => {
    registry.getTask.mockResolvedValue({ id: "bt1", threadId: TID });
    registry.readTaskLogs.mockResolvedValue({
      content: "hello",
      totalBytes: 5,
      truncated: false,
      offset: 0,
    });
    const tools = buildCommandTaskTools(TID, makeRuntime(vi.fn(), vi.fn()), "host");
    const r = await callExecute(tools.readTaskLogs, { taskId: "bt1", tail: 100 });
    expect(r).toMatchObject({ ok: true, content: "hello", totalBytes: 5, truncated: false });
    expect(registry.readTaskLogs).toHaveBeenCalledWith("bt1", {
      offset: undefined,
      tail: 100,
      window: undefined,
    });
  });

  it("跨 thread 任务 → ok:false（owner scope 拦截，不调 readTaskLogs）", async () => {
    registry.getTask.mockResolvedValue({ id: "btX", threadId: "other-thread" });
    const tools = buildCommandTaskTools(TID, makeRuntime(vi.fn(), vi.fn()), "host");
    const r = await callExecute(tools.readTaskLogs, { taskId: "btX" });
    expect(r).toMatchObject({ ok: false });
    expect(registry.readTaskLogs).not.toHaveBeenCalled();
  });

  it("任务不存在 → ok:false", async () => {
    registry.getTask.mockResolvedValue(null);
    const tools = buildCommandTaskTools(TID, makeRuntime(vi.fn(), vi.fn()), "host");
    const r = await callExecute(tools.readTaskLogs, { taskId: "ghost" });
    expect(r).toMatchObject({ ok: false });
  });
});

describe("stopBackgroundTask owner scope", () => {
  it("本 thread 任务 → markStopped(reason=manual)", async () => {
    registry.getTask.mockResolvedValue({ id: "bt1", threadId: TID });
    registry.markStopped.mockResolvedValue({ id: "bt1", status: "stopped" });
    const tools = buildCommandTaskTools(TID, makeRuntime(vi.fn(), vi.fn()), "host");
    const r = await callExecute(tools.stopBackgroundTask, { taskId: "bt1" });
    expect(r).toMatchObject({ ok: true, status: "stopped" });
    expect(registry.markStopped).toHaveBeenCalledWith("bt1", { reason: "manual" });
  });

  it("跨 thread 任务 → ok:false，不调 markStopped", async () => {
    registry.getTask.mockResolvedValue({ id: "btX", threadId: "other" });
    const tools = buildCommandTaskTools(TID, makeRuntime(vi.fn(), vi.fn()), "host");
    const r = await callExecute(tools.stopBackgroundTask, { taskId: "btX" });
    expect(r).toMatchObject({ ok: false });
    expect(registry.markStopped).not.toHaveBeenCalled();
  });
});

describe("listBackgroundTasks", () => {
  it("列当前 thread 任务（精简字段）", async () => {
    const now = new Date();
    registry.listByThread.mockResolvedValue([
      {
        id: "bt1",
        kind: "dev-server",
        command: "npm run dev",
        status: "running",
        runtimeType: "host",
        startedAt: now,
        port: 41000,
      } as BackgroundTask,
    ]);
    const tools = buildCommandTaskTools(TID, makeRuntime(vi.fn(), vi.fn()), "host");
    const r = (await callExecute(tools.listBackgroundTasks, {})) as {
      ok: boolean;
      tasks: Array<{ id: string; kind: string; status: string }>;
    };
    expect(r.ok).toBe(true);
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0]).toMatchObject({ id: "bt1", kind: "dev-server", status: "running" });
  });
});
