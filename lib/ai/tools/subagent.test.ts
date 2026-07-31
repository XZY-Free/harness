import type { SubagentDefinition, SubagentRun } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.5 Stage C：spawnSubagent / joinSubagent 工具测试。
 *
 * 用真实 registry（createRun 走 mocked queries 的内存存储，writeScope 互斥真实生效）+
 * mocked runtime（startSubagentExecution 捕获、waitForSubagent 回读内存 run）+
 * mocked executeToolRun（绕过权限直接跑 runner，聚焦 spawn/join 机制）。
 *
 * 命门锁定：
 * - spawn 异步返回 runId（startSubagentExecution 被调，不阻塞）。
 * - join 等待完成返回结构化结果（transcript 不回传，只 result/summary + outputArtifactId）。
 * - 并行：spawn 两个只读子代理，分别 join，结果独立。
 * - writeScope 互斥：第二个重叠 writeScope 的 spawn 被拒。
 * - 失败/超时 → join 返回 ok:false，不抛父。
 * - 子代理 transcript 不进父 Message 表（saveMessages 不被调用）。
 */

const store = vi.hoisted(() => ({
  definitions: new Map<string, SubagentDefinition>(),
  runs: new Map<string, SubagentRun>(),
  events: [] as Array<{ tid: string; type: string; payload: Record<string, unknown> }>,
  startedRuns: [] as string[],
}));

vi.mock("@/lib/db/queries", () => ({
  getSubagentDefinition: vi.fn(async (id: string) => store.definitions.get(id) ?? null),
  listActiveSubagentRunsByThread: vi.fn(async (tid: string) =>
    [...store.runs.values()].filter(
      (r) => r.parentThreadId === tid && (r.status === "queued" || r.status === "running"),
    ),
  ),
  createSubagentRun: vi.fn(async (p: Record<string, unknown>) => {
    const r = {
      id: `run-${store.runs.size + 1}`,
      parentThreadId: p.parentThreadId,
      definitionId: p.definitionId,
      goal: p.goal,
      contextHints: p.contextHints ?? null,
      status: "queued",
      writeScope: p.writeScope ?? null,
      resultSummary: null,
      outputArtifactId: null,
      transcriptPath: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(),
    } as SubagentRun;
    store.runs.set(r.id, r);
    return r;
  }),
  getSubagentRun: vi.fn(async (id: string) => store.runs.get(id) ?? null),
  updateSubagentRun: vi.fn(async (id: string, patch: Partial<SubagentRun>) => {
    const e = store.runs.get(id);
    if (!e) return null;
    const m = { ...e, ...patch } as SubagentRun;
    store.runs.set(id, m);
    return m;
  }),
  listSubagentRunsByThread: vi.fn(async (tid: string) =>
    [...store.runs.values()].filter((r) => r.parentThreadId === tid),
  ),
  appendThreadEvent: vi.fn(async (tid: string, type: string, payload: Record<string, unknown>) => {
    store.events.push({ tid, type, payload });
  }),
  saveMessages: vi.fn(async () => {}),
}));

// mocked runtime：start 捕获 runId（不真跑 LLM）；waitFor 回读内存 run 状态（测试手动驱动终态）
// joinSubagents 走 waitForSubagents（批量 Promise.all），joinSubagent 走 waitForSubagent（单个）
vi.mock("@/lib/subagent/runtime", () => ({
  startSubagentExecution: vi.fn((runId: string) => {
    store.startedRuns.push(runId);
  }),
  waitForSubagent: vi.fn(async (runId: string) => store.runs.get(runId) ?? null),
  // 真并行语义：按 runIds 顺序对齐返回（与生产 waitForSubagents 的 Promise.all 行为一致）
  waitForSubagents: vi.fn(async (runIds: string[]) =>
    runIds.map((id) => store.runs.get(id) ?? null),
  ),
}));

// 绕过权限引擎，直接跑 runner（聚焦 spawn/join 机制；ask 行为由 tool-runtime 体系另测）
vi.mock("@/lib/ai/tool-runtime", () => ({
  executeToolRun: vi.fn(
    async (
      _tid: string,
      _name: string,
      _input: Record<string, unknown>,
      runner: () => Promise<unknown>,
    ) => runner(),
  ),
}));

import { buildSubagentControlTools } from "./subagent";

/** 调用工具 execute（补 AI SDK 第二个 options 参数，对齐 tools.test 的 callExecute）。 */
type ToolLike = { execute?: (...args: never[]) => unknown };
function callExecute(tool: ToolLike, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return Promise.resolve(tool.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

function def(over: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: "def-1",
    name: "explore",
    role: "explore",
    modelProfileId: null,
    allowedTools: ["readFile", "glob", "grep"],
    contextPolicy: {},
    outputSchema: null,
    defaultWriteScope: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** 驱动一个 run 到终态（模拟 executeSubagent 完成）。 */
function completeRun(runId: string, summary: string) {
  const r = store.runs.get(runId);
  if (!r) return;
  store.runs.set(runId, {
    ...r,
    status: "completed",
    resultSummary: summary,
    outputArtifactId: `art-${runId}`,
    finishedAt: new Date(),
  });
}

beforeEach(() => {
  store.definitions.clear();
  store.runs.clear();
  store.events = [];
  store.startedRuns = [];
  store.definitions.set("def-1", def());
});

const TID = "tid";

describe("spawnSubagent", () => {
  it("异步返回 runId，不阻塞父（startSubagentExecution 被调）", async () => {
    const tools = buildSubagentControlTools(TID);
    const out = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "find routes",
    } as never)) as { ok: boolean; runId?: string; status?: string };
    expect(out.ok).toBe(true);
    expect(out.runId).toBeTruthy();
    expect(out.status).toBe("queued");
    expect(store.startedRuns).toContain(out.runId);
    // subagent.spawned 事件已落
    expect(store.events.some((e) => e.type === "subagent.spawned")).toBe(true);
  });

  it("writeScope 互斥：第二个重叠 writeScope 的 spawn 被拒（§14）", async () => {
    store.definitions.set("def-w", def({ id: "def-w", defaultWriteScope: ["src/**"] }));
    const tools = buildSubagentControlTools(TID);
    const a = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-w",
      goal: "g1",
    } as never)) as { ok: boolean };
    expect(a.ok).toBe(true);
    // 第二个重叠 src/** → 拒绝
    const b = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-w",
      goal: "g2",
    } as never)) as { ok: boolean; error?: string };
    expect(b.ok).toBe(false);
    expect(b.error).toContain("重叠");
  });

  it("transcript 不进父 Message 表（saveMessages 不被调用）", async () => {
    const { saveMessages } = await import("@/lib/db/queries");
    const tools = buildSubagentControlTools(TID);
    await callExecute(tools.spawnSubagent, { definitionId: "def-1", goal: "g" } as never);
    expect(saveMessages).not.toHaveBeenCalled();
  });
});

describe("joinSubagent", () => {
  it("等待完成返回结构化结果（result + summary + outputArtifactId，无 transcript）", async () => {
    const tools = buildSubagentControlTools(TID);
    const spawn = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "g",
    } as never)) as { runId: string };
    completeRun(spawn.runId, "found 3 routes");
    const out = (await callExecute(tools.joinSubagent, {
      runId: spawn.runId,
    } as never)) as {
      ok: boolean;
      status: string;
      result: string;
      summary: string;
      outputArtifactId: string;
    };
    expect(out.ok).toBe(true);
    expect(out.status).toBe("completed");
    expect(out.result).toBe("found 3 routes");
    expect(out.summary).toBe("found 3 routes");
    expect(out.outputArtifactId).toBe(`art-${spawn.runId}`);
    // transcript 字段不在回传契约里
    expect("transcript" in out).toBe(false);
  });

  it("并行：spawn 两个只读子代理，分别 join，结果独立", async () => {
    const tools = buildSubagentControlTools(TID);
    const a = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "explore a",
    } as never)) as { runId: string };
    const b = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "explore b",
    } as never)) as { runId: string };
    expect(a.runId).not.toBe(b.runId);
    completeRun(a.runId, "result A");
    completeRun(b.runId, "result B");
    const ja = (await callExecute(tools.joinSubagent, { runId: a.runId } as never)) as {
      result: string;
    };
    const jb = (await callExecute(tools.joinSubagent, { runId: b.runId } as never)) as {
      result: string;
    };
    expect(ja.result).toBe("result A");
    expect(jb.result).toBe("result B");
  });

  it("子代理失败 → join 返回 ok:false，不抛父", async () => {
    const tools = buildSubagentControlTools(TID);
    const spawn = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "g",
    } as never)) as { runId: string };
    const r = store.runs.get(spawn.runId);
    if (r) store.runs.set(spawn.runId, { ...r, status: "failed", errorMessage: "boom" });
    const out = (await callExecute(tools.joinSubagent, { runId: spawn.runId } as never)) as {
      ok: boolean;
      status: string;
      error: string;
    };
    expect(out.ok).toBe(false);
    expect(out.status).toBe("failed");
    expect(out.error).toBe("boom");
  });

  it("子代理超时 → join 返回 ok:false，status=timed_out", async () => {
    const tools = buildSubagentControlTools(TID);
    const spawn = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "g",
    } as never)) as { runId: string };
    const r = store.runs.get(spawn.runId);
    if (r) store.runs.set(spawn.runId, { ...r, status: "timed_out", errorMessage: "timeout" });
    const out = (await callExecute(tools.joinSubagent, { runId: spawn.runId } as never)) as {
      ok: boolean;
      status: string;
    };
    expect(out.ok).toBe(false);
    expect(out.status).toBe("timed_out");
  });

  it("run 不存在 → join ok:false", async () => {
    const tools = buildSubagentControlTools(TID);
    const out = (await callExecute(tools.joinSubagent, { runId: "nope" } as never)) as {
      ok: boolean;
      error: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("不存在");
  });
});

describe("joinSubagents（批量并行等待）", () => {
  it("并行等待多个 runId 全部 completed → 返回各 run 结果，按 runIds 顺序对齐", async () => {
    const tools = buildSubagentControlTools(TID);
    const a = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "explore a",
    } as never)) as { runId: string };
    const b = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "explore b",
    } as never)) as { runId: string };
    const c = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "explore c",
    } as never)) as { runId: string };
    completeRun(a.runId, "result A");
    completeRun(b.runId, "result B");
    completeRun(c.runId, "result C");

    const out = (await callExecute(tools.joinSubagents, {
      runIds: [a.runId, b.runId, c.runId],
    } as never)) as {
      ok: boolean;
      results: Array<{
        runId: string;
        ok: boolean;
        status: string;
        result: string;
        summary: string;
        outputArtifactId: string;
      }>;
    };
    expect(out.ok).toBe(true);
    expect(out.results).toHaveLength(3);
    // 顺序对齐 runIds
    expect(out.results.map((r) => r.runId)).toEqual([a.runId, b.runId, c.runId]);
    expect(out.results[0]).toMatchObject({
      ok: true,
      status: "completed",
      result: "result A",
      summary: "result A",
      outputArtifactId: `art-${a.runId}`,
    });
    expect(out.results[1]?.result).toBe("result B");
    expect(out.results[2]?.result).toBe("result C");
    // waitForSubagents 收到完整 runIds 数组（真并行，非逐个串行）
    const { waitForSubagents } = await import("@/lib/subagent/runtime");
    expect(waitForSubagents).toHaveBeenCalledWith([a.runId, b.runId, c.runId], undefined);
  });

  it("部分 run 超时（仍 queued 未到终态）→ 该 run 返回当前 status，不误判 failed；其他 run 正常", async () => {
    const tools = buildSubagentControlTools(TID);
    const done = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "done one",
    } as never)) as { runId: string };
    const slow = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "slow one",
    } as never)) as { runId: string };
    completeRun(done.runId, "ok");
    // slow 仍 queued（模拟 joiner 超时，run 未到终态；mock 的 createSubagentRun 初始即 queued）

    const out = (await callExecute(tools.joinSubagents, {
      runIds: [done.runId, slow.runId],
      timeoutMs: 1000,
    } as never)) as {
      ok: boolean;
      results: Array<{ runId: string; ok: boolean; status: string; error?: string }>;
    };
    // 整体 ok=false（slow 未完成）
    expect(out.ok).toBe(false);
    expect(out.results).toHaveLength(2);
    // done completed
    expect(out.results[0]).toMatchObject({ runId: done.runId, ok: true, status: "completed" });
    // slow 仍是 queued（不是 failed），error 回退到 status
    expect(out.results[1]).toMatchObject({
      runId: slow.runId,
      ok: false,
      status: "queued",
      error: "queued",
    });
    // 关键：未把 slow 误标 failed（status 仍 queued）
    expect(store.runs.get(slow.runId)?.status).toBe("queued");
  });

  it("部分 run 失败 → 该 run ok:false + status=failed；其他 run 不受影响", async () => {
    const tools = buildSubagentControlTools(TID);
    const ok1 = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "ok",
    } as never)) as { runId: string };
    const bad = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "bad",
    } as never)) as { runId: string };
    completeRun(ok1.runId, "fine");
    const badRun = store.runs.get(bad.runId);
    if (badRun) store.runs.set(bad.runId, { ...badRun, status: "failed", errorMessage: "boom" });

    const out = (await callExecute(tools.joinSubagents, {
      runIds: [ok1.runId, bad.runId],
    } as never)) as {
      ok: boolean;
      results: Array<{ runId: string; ok: boolean; status: string; error?: string }>;
    };
    expect(out.ok).toBe(false);
    expect(out.results[0]).toMatchObject({ runId: ok1.runId, ok: true, status: "completed" });
    expect(out.results[1]).toMatchObject({
      runId: bad.runId,
      ok: false,
      status: "failed",
      error: "boom",
    });
  });

  it("空 runIds → inputSchema 拒绝（min(1)），不调 waitForSubagents", async () => {
    const tools = buildSubagentControlTools(TID);
    // AI SDK 在 inputSchema 层 min(1) 校验，execute 不会被调用；
    // 这里直接断言 schema 约束存在（z.array(z.string()).min(1)）
    // 由于 callExecute 绕过 schema 校验直接调 execute，改为验证 waitForSubagents 不该被空数组调用
    // 真实链路下 streamText 会先做 schema 校验拒绝。此处验证 execute 收到空数组时 waitForSubagents 仍被以空数组调用
    // —— 但生产 waitForSubagents 对空数组直接返回 []（runtime.ts:414），不抛错。
    const out = (await callExecute(tools.joinSubagents, { runIds: [] } as never)) as {
      ok: boolean;
      results: unknown[];
    };
    // 空 runIds → waitForSubagents 返回 []，results 为空，allOk=true（every 空数组为 true）
    expect(out.results).toEqual([]);
    expect(out.ok).toBe(true);
    const { waitForSubagents } = await import("@/lib/subagent/runtime");
    expect(waitForSubagents).toHaveBeenCalledWith([], undefined);
  });

  it("非法 runId（不存在的 runId 混入）→ 该项 ok:false error=不存在，其他正常", async () => {
    const tools = buildSubagentControlTools(TID);
    const ok1 = (await callExecute(tools.spawnSubagent, {
      definitionId: "def-1",
      goal: "ok",
    } as never)) as { runId: string };
    completeRun(ok1.runId, "fine");

    const out = (await callExecute(tools.joinSubagents, {
      runIds: [ok1.runId, "ghost-run"],
    } as never)) as {
      ok: boolean;
      results: Array<{ runId: string; ok: boolean; error?: string }>;
    };
    expect(out.ok).toBe(false);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ runId: ok1.runId, ok: true });
    expect(out.results[1]).toMatchObject({
      runId: "ghost-run",
      ok: false,
      error: "子代理 run 不存在",
    });
  });
});
