import { beforeEach, describe, expect, it, vi } from "vitest";

const toolRuntime = vi.hoisted(() => ({ executeToolRun: vi.fn() }));
vi.mock("@/lib/ai/tool-runtime", () => ({
  executeToolRun: toolRuntime.executeToolRun,
}));

const store = vi.hoisted(() => ({ createMemory: vi.fn() }));
vi.mock("@/lib/memory/store", () => ({
  createMemory: store.createMemory,
}));

import { buildMemoryTools } from "./memory";

type ToolLike = { execute?: (...args: never[]) => unknown };
function callExecute(tool: ToolLike, input: unknown): Promise<Record<string, unknown>> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return Promise.resolve(
    tool.execute(input as never, { toolCallId: "t", messages: [] } as never),
  ) as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // executeToolRun 透传 runner（模拟 allow 直跑）
  toolRuntime.executeToolRun.mockImplementation(
    async (_t: string, _n: string, _i: unknown, runner: () => Promise<unknown>) => runner(),
  );
});

describe("rememberFact 工具（Stage D）", () => {
  it("经 executeToolRun 收口 + createMemory → ok:true, memoryId, deduplicated, semanticStatus", async () => {
    store.createMemory.mockResolvedValue({
      memory: { id: "m1" },
      deduplicated: false,
      semanticStatus: "ready",
    });
    const tools = buildMemoryTools("t1");
    const r = await callExecute(tools.rememberFact, {
      kind: "convention",
      text: "commit 用 Lore trailer",
      scope: "project",
      scopeRef: "p1",
      provenance: [{ kind: "user", refId: "u1" }],
    });
    expect(toolRuntime.executeToolRun).toHaveBeenCalledOnce();
    expect(store.createMemory).toHaveBeenCalledOnce();
    expect(r).toMatchObject({
      ok: true,
      memoryId: "m1",
      deduplicated: false,
      semanticStatus: "ready",
    });
    const args = store.createMemory.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      scope: "project",
      kind: "convention",
      text: "commit 用 Lore trailer",
      confidence: "medium",
    });
  });

  it("去重：createMemory 返回 deduplicated:true → 工具返回 deduplicated:true", async () => {
    store.createMemory.mockResolvedValue({
      memory: { id: "m-dup" },
      deduplicated: true,
      semanticStatus: "ready",
    });
    const tools = buildMemoryTools("t1");
    const r = await callExecute(tools.rememberFact, {
      kind: "convention",
      text: "commit 用 Lore trailer",
      scope: "project",
      scopeRef: "p1",
      provenance: [{ kind: "user", refId: "u1" }],
    });
    expect(r).toMatchObject({ ok: true, memoryId: "m-dup", deduplicated: true });
  });

  it("V3.3b Stage B：provider error → 记忆写入成功 ok:true，但 semanticStatus:error（不静默伪装 ready）", async () => {
    store.createMemory.mockResolvedValue({
      memory: { id: "m-err" },
      deduplicated: false,
      semanticStatus: "error",
    });
    const tools = buildMemoryTools("t1");
    const r = await callExecute(tools.rememberFact, {
      kind: "convention",
      text: "commit 用 Lore trailer",
      scope: "project",
      scopeRef: "p1",
      provenance: [{ kind: "user", refId: "u1" }],
    });
    expect(r).toMatchObject({ ok: true, memoryId: "m-err", semanticStatus: "error" });
  });

  it("createMemory 抛（provenance 非法）→ ok:false，不传播异常", async () => {
    store.createMemory.mockRejectedValue(new Error("provenance 必填：记忆必须带来源（至少一条）"));
    const tools = buildMemoryTools("t1");
    const r = await callExecute(tools.rememberFact, {
      kind: "convention",
      text: "x",
      scope: "project",
      scopeRef: "p1",
      provenance: [{ kind: "user", refId: "u1" }],
    });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/provenance/);
  });

  it("confidence 可选，默认 medium 传入 createMemory", async () => {
    store.createMemory.mockResolvedValue({ memory: { id: "m1" }, deduplicated: false });
    const tools = buildMemoryTools("t1");
    await callExecute(tools.rememberFact, {
      kind: "decision",
      text: "runtime 三层抽象",
      scope: "user",
      scopeRef: "u1",
      confidence: "high",
      provenance: [{ kind: "tool_run", refId: "tr-1", threadId: "t1" }],
    });
    expect(store.createMemory.mock.calls[0]?.[0]).toMatchObject({ confidence: "high" });
  });
});
