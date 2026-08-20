import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V4 Phase B-6 + 12-P1-3：全局会话状态 SSE 端点双通道 + 单 thread 全事件模式测试。
 *
 * 全局模式（无 threadId）：DB 轮询 listThreadStatusChanges 提供 status。
 * threadId 模式：进程内 onThreadEvent + 通道2 listThreadEventsSince。
 * 去重：同 threadId 同 status / 同 sequence 不重复推。
 */

const auth = vi.hoisted(() => ({
  getCurrentUserFromRequest: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  listThreadStatusChanges: vi.fn(),
  listThreadEventsSince: vi.fn(),
  getThreadByIdForUser: vi.fn(),
}));
const bus = vi.hoisted(() => ({
  onThreadEvent: vi.fn(),
  eventListener: null as
    | ((e: { threadId: string; type: string; payload: unknown; sequence: number }) => void)
    | null,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserFromRequest: auth.getCurrentUserFromRequest,
}));
vi.mock("@/lib/db/queries", () => ({
  listThreadStatusChanges: queries.listThreadStatusChanges,
  listThreadEventsSince: queries.listThreadEventsSince,
  getThreadByIdForUser: queries.getThreadByIdForUser,
}));
// 审计修复：mock db client + schema，供全局模式 userThreadIds 预加载查询
const mockDbChain = vi.hoisted(() => {
  // 默认返回测试中用到的 threadId，让 userThreadIds 过滤放行
  let mockRows: Array<{ id: string }> = [{ id: "t1" }, { id: "t2" }, { id: "t3" }, { id: "t4" }];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => Promise.resolve(mockRows);
  chain.__setRows = (rows: Array<{ id: string }>) => {
    mockRows = rows;
  };
  return chain;
});
vi.mock("@/lib/db/client", () => ({
  db: mockDbChain,
}));
vi.mock("@/lib/db/schema", () => ({
  thread: { id: "id", userId: "userId", deletedAt: "deletedAt" },
}));
vi.mock("@/lib/runtime/thread-events-bus", () => ({
  onThreadEvent: (
    cb: (e: { threadId: string; type: string; payload: unknown; sequence: number }) => void,
  ) => {
    bus.eventListener = cb;
    return () => {};
  },
}));

import { GET } from "./route";

function makeRequest(threadId?: string) {
  const ac = new AbortController();
  const url =
    threadId !== undefined
      ? `http://localhost/api/threads/stream?threadId=${threadId}`
      : "http://localhost/api/threads/stream";
  const req = new Request(url, { signal: ac.signal });
  return { req, ac };
}

function decode(v: Uint8Array | undefined): string {
  return v ? new TextDecoder().decode(v) : "";
}

function getReader(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!res.body) throw new Error("response body missing");
  return res.body.getReader();
}

beforeEach(() => {
  vi.useFakeTimers();
  auth.getCurrentUserFromRequest.mockResolvedValue({ id: "u1" });
  queries.listThreadStatusChanges.mockResolvedValue([]);
  queries.listThreadEventsSince.mockResolvedValue([]);
  // 审计修复：threadMode 所有权校验默认返回有效 thread（通过权限检查）
  queries.getThreadByIdForUser.mockResolvedValue({ id: "mock-thread", userId: "u1" });
  bus.eventListener = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("threads/stream SSE B-6 全局模式（无 threadId）", () => {
  it("未授权 → 401", async () => {
    auth.getCurrentUserFromRequest.mockRejectedValue(new Error("no auth"));
    const { req } = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("全局模式不订阅进程内 thread-events-bus（仅 DB 轮询提供 status）", async () => {
    const { req, ac } = makeRequest();
    const res = await GET(req);
    const reader = getReader(res);
    // 全局模式不订阅 onThreadEvent
    expect(bus.eventListener).toBeNull();
    ac.abort();
  });

  it("通道2：DB 轮询补推他实例变更", async () => {
    queries.listThreadStatusChanges.mockResolvedValue([
      { threadId: "t2", status: "failed", updatedAt: new Date("2026-06-26T00:05:00Z") },
    ]);
    const { req, ac } = makeRequest();
    const res = await GET(req);
    const reader = getReader(res);
    await vi.advanceTimersByTimeAsync(3000);
    const { value } = await reader.read();
    const text = decode(value);
    expect(text).toContain('"threadId":"t2"');
    expect(text).toContain('"status":"failed"');
    ac.abort();
  });

  it("去重：同 threadId 同 status 不重复推", async () => {
    queries.listThreadStatusChanges.mockResolvedValue([
      { threadId: "t3", status: "running", updatedAt: new Date("2026-06-26T00:06:00Z") },
    ]);
    const { req, ac } = makeRequest();
    const res = await GET(req);
    const reader = getReader(res);
    // 第一轮轮询推送 t3
    await vi.advanceTimersByTimeAsync(3000);
    const first = await reader.read();
    expect(decode(first.value)).toContain('"threadId":"t3"');
    // 第二轮同样 status（同 updatedAt）→ 去重不推；新 status t4 推送
    queries.listThreadStatusChanges.mockResolvedValueOnce([
      { threadId: "t3", status: "running", updatedAt: new Date("2026-06-26T00:06:00Z") },
      { threadId: "t4", status: "done", updatedAt: new Date("2026-06-26T00:07:00Z") },
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    const second = await reader.read();
    const text2 = decode(second.value);
    expect(text2).toContain('"threadId":"t4"');
    expect(text2).not.toContain('"threadId":"t3"');
    ac.abort();
  });
});

describe("threads/stream SSE 12-P1-3 threadId 模式", () => {
  it("threadId 模式订阅 onThreadEvent，推送 event 事件（信封 kind=event）", async () => {
    const { req, ac } = makeRequest("tid-1");
    const res = await GET(req);
    const reader = getReader(res);
    expect(bus.eventListener).not.toBeNull();
    const evtListener = bus.eventListener;
    if (!evtListener) throw new Error("event listener not captured");
    evtListener({
      threadId: "tid-1",
      type: "subagent.spawned",
      payload: { runId: "sa1" },
      sequence: 5,
    });
    const { value } = await reader.read();
    const text = decode(value);
    expect(text).toContain('"kind":"event"');
    expect(text).toContain('"type":"subagent.spawned"');
    expect(text).toContain('"sequence":5');
    ac.abort();
  });

  it("threadId 模式仅推该 thread 的 event，其他 thread 事件过滤", async () => {
    const { req, ac } = makeRequest("tid-1");
    const res = await GET(req);
    const reader = getReader(res);
    const evtListener = bus.eventListener;
    if (!evtListener) throw new Error("event listener not captured");
    // 其他 thread 的事件应被过滤
    evtListener({
      threadId: "tid-other",
      type: "subagent.spawned",
      payload: {},
      sequence: 1,
    });
    // 本 thread 的事件推送
    evtListener({
      threadId: "tid-1",
      type: "task.started",
      payload: { taskId: "x" },
      sequence: 2,
    });
    const { value } = await reader.read();
    const text = decode(value);
    expect(text).toContain('"threadId":"tid-1"');
    expect(text).not.toContain('"tid-other"');
    ac.abort();
  });

  it("threadId 模式通道2：DB 轮询补推他实例 event（listThreadEventsSince）", async () => {
    queries.listThreadEventsSince.mockResolvedValue([
      {
        threadId: "tid-1",
        type: "qa.check_failed",
        payload: { checkId: "q1" },
        sequence: 10,
        createdAt: new Date("2026-06-26T00:08:00Z"),
      },
    ]);
    const { req, ac } = makeRequest("tid-1");
    const res = await GET(req);
    const reader = getReader(res);
    await vi.advanceTimersByTimeAsync(3000);
    const { value } = await reader.read();
    const text = decode(value);
    expect(text).toContain('"type":"qa.check_failed"');
    expect(text).toContain('"sequence":10');
    ac.abort();
  });

  it("event 去重：同 sequence 不重复推", async () => {
    const { req, ac } = makeRequest("tid-1");
    const res = await GET(req);
    const reader = getReader(res);
    const evtListener = bus.eventListener;
    if (!evtListener) throw new Error("event listener not captured");
    // 进程内推 sequence 7
    evtListener({
      threadId: "tid-1",
      type: "task.started",
      payload: {},
      sequence: 7,
    });
    const first = await reader.read();
    expect(decode(first.value)).toContain('"sequence":7');
    // 轮询也读到 sequence 7 → 应跳过，只推 sequence 8
    queries.listThreadEventsSince.mockResolvedValueOnce([
      {
        threadId: "tid-1",
        type: "task.started",
        payload: {},
        sequence: 7,
        createdAt: new Date("2026-06-26T00:09:00Z"),
      },
      {
        threadId: "tid-1",
        type: "task.stopped",
        payload: {},
        sequence: 8,
        createdAt: new Date("2026-06-26T00:09:01Z"),
      },
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    const second = await reader.read();
    const text2 = decode(second.value);
    expect(text2).toContain('"sequence":8');
    expect(text2).not.toContain('"sequence":7');
    ac.abort();
  });
});
