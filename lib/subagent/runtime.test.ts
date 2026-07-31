import type { SubagentDefinition, SubagentRun } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.5 Stage C：executeSubagent 嵌套执行测试。
 *
 * 命门锁定：
 * - transcript 落 artifact 文件（transcriptWriter 被调用），不进父 Message 表（runtime 不调 saveMessages）。
 * - outputSchema 不合格 → failed。
 * - 失败/超时 → run 终态，executeSubagent 不向上抛（失败不崩父）。
 * - 嵌套深度=1：传给模型执行器的工具集不含 spawnSubagent/joinSubagent。
 */

// ─── 受控存储 + mock ─────────────────────────────────────────
const store = vi.hoisted(() => ({
  runs: new Map<string, SubagentRun>(),
  transcriptWrites: [] as Array<{ runId: string; data: unknown }>,
  modelCalls: [] as Array<{ tools: string[] }>,
  contextArgs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/subagent/registry", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/subagent/registry")>();
  return {
    ...actual,
    getRun: vi.fn(async (id: string) => store.runs.get(id) ?? null),
    getDefinition: vi.fn(async () => def() as unknown as SubagentDefinition),
    updateRunStatus: vi.fn(async (id: string, status: never, extra?: Record<string, unknown>) => {
      const r = store.runs.get(id);
      if (!r) return null;
      const merged = {
        ...r,
        status,
        resultSummary: (extra?.resultSummary as string | null | undefined) ?? r.resultSummary,
        outputArtifactId:
          (extra?.outputArtifactId as string | null | undefined) ?? r.outputArtifactId,
        errorMessage: (extra?.errorMessage as string | null | undefined) ?? r.errorMessage,
      } as SubagentRun;
      store.runs.set(id, merged);
      return merged;
    }),
  };
});

vi.mock("@/lib/subagent/context", () => ({
  buildSubagentContextPackage: vi.fn(async (args: Record<string, unknown>) => {
    store.contextArgs.push(args);
    return {
      messages: [{ role: "user", content: [{ type: "text", text: "goal" }] }],
      manifest: {
        appliedSummaryIds: [],
        summaries: [],
        excludedCandidates: [],
        protectedRefs: [],
        beforeTokens: 0,
        afterTokens: 0,
      },
      compressed: false,
    };
  }),
}));

vi.mock("@/lib/subagent/tool-scope", () => ({
  // 故意含 spawnSubagent，验证 runtime 会剥离（嵌套深度=1）
  buildSubagentTools: vi.fn(() => ({
    readFile: { name: "readFile" },
    spawnSubagent: { name: "spawnSubagent" },
    joinSubagent: { name: "joinSubagent" },
  })),
}));

vi.mock("@/lib/db/queries", () => ({
  getThreadById: vi.fn(async () => ({ model: "m", runtimeType: "container" })),
  getActiveThreadPlan: vi.fn(async () => ({ id: "plan-1", title: "plan", status: "active" })),
  listThreadPlanItems: vi.fn(async () => [{ id: "item-1", title: "step", status: "pending" }]),
  listToolRunsByThread: vi.fn(async () => [{ id: "tool-1", toolName: "readFile", input: {} }]),
  updateSubagentRun: vi.fn(async () => null),
  saveMessages: vi.fn(async () => {}),
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  executeSubagent,
  setSubagentModelRunner,
  setSubagentTranscriptWriter,
  waitForSubagent,
  waitForSubagents,
} from "./runtime";
import type { SubagentModelRunner, TranscriptWriter } from "./runtime";

function def(over: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: "def-1",
    name: "explore",
    role: "explore",
    modelProfileId: "m",
    allowedTools: ["readFile", "glob", "grep"],
    contextPolicy: {},
    outputSchema: null,
    defaultWriteScope: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function queuedRun(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "run-1",
    parentThreadId: "tid",
    definitionId: "def-1",
    goal: "g",
    contextHints: null,
    status: "queued",
    writeScope: null,
    resultSummary: null,
    outputArtifactId: null,
    transcriptPath: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

const fakeTranscriptWriter: TranscriptWriter = async ({ runId, data }) => {
  store.transcriptWrites.push({ runId, data });
  return `.snow/runtime/tid/subagents/${runId}/transcript.json`;
};

beforeEach(() => {
  store.runs.clear();
  store.transcriptWrites = [];
  store.modelCalls = [];
  store.contextArgs = [];
  setSubagentTranscriptWriter(fakeTranscriptWriter);
});

describe("executeSubagent 成功路径", () => {
  it("queued→completed：outputSchema 校验通过，写 transcript + resultSummary + outputArtifactId", async () => {
    store.runs.set("run-1", queuedRun());
    const fakeRunner: SubagentModelRunner = async (args) => {
      store.modelCalls.push({ tools: Object.keys(args.tools) });
      return { text: '{"summary":"found 3 files"}', finishReason: "stop" };
    };
    setSubagentModelRunner(fakeRunner);

    const run = await executeSubagent("run-1");

    expect(run?.status).toBe("completed");
    expect(run?.resultSummary).toContain("found 3 files");
    expect(run?.outputArtifactId).toContain("run-1");
    // transcript 落 artifact 文件
    expect(store.transcriptWrites.length).toBeGreaterThanOrEqual(1);
    expect(store.transcriptWrites[0]?.data).toMatchObject({ runId: "run-1", goal: "g" });
  });

  it("无 outputSchema → 任意输出都 completed", async () => {
    store.runs.set("run-1", queuedRun());
    setSubagentModelRunner(async () => ({ text: "自由文本结果", finishReason: "stop" }));
    const run = await executeSubagent("run-1");
    expect(run?.status).toBe("completed");
  });
});

describe("executeSubagent outputSchema 校验", () => {
  it("输出不符合 outputSchema → failed", async () => {
    store.runs.set(
      "run-1",
      queuedRun({
        definitionId: "def-schema",
      }),
    );
    // getDefinition mock 返回带 outputSchema 的 def
    const { getDefinition } = await import("@/lib/subagent/registry");
    (getDefinition as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      def({
        id: "def-schema",
        outputSchema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
        },
      }) as never,
    );
    setSubagentModelRunner(async () => ({ text: "not json at all", finishReason: "stop" }));

    const run = await executeSubagent("run-1");
    expect(run?.status).toBe("failed");
    expect(run?.errorMessage).toContain("outputSchema 校验失败");
  });
});

describe("executeSubagent 失败不崩父", () => {
  it("模型执行抛异常 → run failed，executeSubagent 不抛", async () => {
    store.runs.set("run-1", queuedRun());
    setSubagentModelRunner(async () => {
      throw new Error("model boom");
    });
    const run = await executeSubagent("run-1");
    expect(run?.status).toBe("failed");
    expect(run?.errorMessage).toContain("model boom");
  });

  it("超时 → run timed_out，不抛", async () => {
    store.runs.set("run-1", queuedRun());
    setSubagentModelRunner(
      async () => new Promise(() => {}), // 永不 resolve
    );
    const run = await executeSubagent("run-1", { timeoutMs: 50 });
    expect(run?.status).toBe("timed_out");
  });

  // S1（04-G6）：cancelSubagentExecution abort 验证
  it("abortSignal 触发 → run cancelled（不判 failed/timed_out）", async () => {
    store.runs.set("run-1", queuedRun());
    const ac = new AbortController();
    setSubagentModelRunner(
      (args) =>
        new Promise((_resolve, reject) => {
          args.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const p = executeSubagent("run-1", { abortSignal: ac.signal, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const run = await p;
    expect(run?.status).toBe("cancelled");
  });

  // S1（04-G4）：maxSteps 覆盖透传
  it("maxSteps 覆盖透传到 modelRunner", async () => {
    store.runs.set("run-1", queuedRun());
    let received: number | undefined;
    setSubagentModelRunner(async (args) => {
      received = args.maxSteps;
      return { text: "ok", finishReason: "stop" };
    });
    await executeSubagent("run-1", { maxSteps: 5 });
    expect(received).toBe(5);
  });
});

describe("executeSubagent 嵌套深度=1（剥离 spawn 能力）", () => {
  it("传给模型执行器的工具集不含 spawnSubagent/joinSubagent", async () => {
    store.runs.set("run-1", queuedRun());
    setSubagentModelRunner(async (args) => {
      store.modelCalls.push({ tools: Object.keys(args.tools) });
      return { text: "ok", finishReason: "stop" };
    });
    await executeSubagent("run-1");
    expect(store.modelCalls[0]?.tools).not.toContain("spawnSubagent");
    expect(store.modelCalls[0]?.tools).not.toContain("joinSubagent");
    expect(store.modelCalls[0]?.tools).toContain("readFile");
  });
});

describe("executeSubagent transcript 不进父 Message 表", () => {
  it("transcript 落 artifact 文件，saveMessages 不被调用", async () => {
    store.runs.set("run-1", queuedRun());
    setSubagentModelRunner(async () => ({ text: "ok", finishReason: "stop" }));
    await executeSubagent("run-1");
    const { saveMessages } = await import("@/lib/db/queries");
    expect(saveMessages).not.toHaveBeenCalled();
    expect(store.transcriptWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("contextHints/includePlan/includeToolEvidence 接到主链路", async () => {
    store.runs.set(
      "run-1",
      queuedRun({
        contextHints: ["路由在 app/api 下"],
      }),
    );
    const { getDefinition } = await import("@/lib/subagent/registry");
    (getDefinition as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      def({
        contextPolicy: { includePlan: true, includeToolEvidence: true },
      }) as never,
    );
    setSubagentModelRunner(async () => ({ text: "ok", finishReason: "stop" }));
    const run = await executeSubagent("run-1");
    expect(run).toMatchObject({ status: "completed", errorMessage: null });
    expect(store.contextArgs[0]).toMatchObject({
      contextHints: ["路由在 app/api 下"],
      activePlan: expect.objectContaining({ id: "plan-1" }),
    });
    expect(store.contextArgs[0]?.planItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "item-1" })]),
    );
    expect(store.contextArgs[0]?.recentToolEvidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "tool-1" })]),
    );
  });

  it("非 queued run（已终态）→ 不重复执行，直接返回", async () => {
    store.runs.set("run-1", queuedRun({ status: "completed", resultSummary: "done" }));
    setSubagentModelRunner(async () => {
      throw new Error("should not run");
    });
    const run = await executeSubagent("run-1");
    expect(run?.status).toBe("completed");
    expect(run?.resultSummary).toBe("done");
  });
});

// ─── P0 修复（G1 真并行）：waitForSubagents / waitForSubagent 批量等待 ───
//
// 命门锁定：
// - 空 runIds → 立即返回 []，不调 waitForSubagent。
// - 多个 runId 并行等待（Promise.all），结果按 runIds 顺序对齐。
// - 每个 run 独立超时/失败，互不影响。
// - 超时只返回当前 status，不修改 run 状态（P0 修复 G1/G8：去掉误判 failed:detached）。
// - run 不存在 → 对应项 null。
describe("waitForSubagents（批量并行等待）", () => {
  it("空 runIds → 立即返回 []，不发起等待", async () => {
    const runs = await waitForSubagents([]);
    expect(runs).toEqual([]);
  });

  it("多个终态 run → Promise.all 并行返回，按 runIds 顺序对齐", async () => {
    store.runs.set("r-a", queuedRun({ id: "r-a", status: "completed", resultSummary: "A" }));
    store.runs.set("r-b", queuedRun({ id: "r-b", status: "completed", resultSummary: "B" }));
    store.runs.set("r-c", queuedRun({ id: "r-c", status: "failed", errorMessage: "boom" }));

    const runs = await waitForSubagents(["r-a", "r-b", "r-c"]);
    expect(runs).toHaveLength(3);
    // 顺序对齐 runIds
    expect(runs.map((r) => r?.id)).toEqual(["r-a", "r-b", "r-c"]);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[1]?.resultSummary).toBe("B");
    expect(runs[2]?.status).toBe("failed");
    expect(runs[2]?.errorMessage).toBe("boom");
  });

  it("部分 run 不存在 → 对应项 null，其他正常返回", async () => {
    store.runs.set("r-ok", queuedRun({ id: "r-ok", status: "completed" }));

    const runs = await waitForSubagents(["r-ok", "ghost", "r-ok2"]);
    expect(runs).toHaveLength(3);
    expect(runs[0]?.id).toBe("r-ok");
    expect(runs[1]).toBeNull();
    expect(runs[2]).toBeNull();
  });

  it("detached running run 超时 → 返回当前 status=running，不修改 run 状态（不误判 failed）", async () => {
    vi.useFakeTimers();
    store.runs.set("r-run", queuedRun({ id: "r-run", status: "running" }));
    // detached：不在 activeRuns（进程重启场景），getRun 返回 running → 进轮询分支
    const p = waitForSubagents(["r-run"], 500);
    // 推进超时（500ms 预算 + 250ms 轮询间隔）
    await vi.advanceTimersByTimeAsync(600);
    const runs = await p;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");
    // 关键：未把 run 误标 failed（P0 修复 G1/G8：超时不修改状态）
    expect(store.runs.get("r-run")?.status).toBe("running");
    // updateRunStatus 不应被超时路径调用（误判修复验证）
    const { updateRunStatus } = await import("@/lib/subagent/registry");
    expect(updateRunStatus).not.toHaveBeenCalledWith("r-run", "failed", expect.anything());
    vi.useRealTimers();
  });

  it("混合：终态 + 不存在 + 超时 running → 各项独立，互不影响", async () => {
    vi.useFakeTimers();
    store.runs.set("r-done", queuedRun({ id: "r-done", status: "completed" }));
    store.runs.set("r-run", queuedRun({ id: "r-run", status: "running" }));

    const p = waitForSubagents(["r-done", "ghost", "r-run"], 400);
    await vi.advanceTimersByTimeAsync(500);
    const runs = await p;
    expect(runs).toHaveLength(3);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[1]).toBeNull();
    expect(runs[2]?.status).toBe("running");
    vi.useRealTimers();
  });
});

describe("waitForSubagent（单个等待，超时不修改状态）", () => {
  it("终态 run → 直接返回 current，不轮询", async () => {
    store.runs.set("r-fin", queuedRun({ id: "r-fin", status: "cancelled" }));
    const run = await waitForSubagent("r-fin");
    expect(run?.status).toBe("cancelled");
  });

  it("run 不存在 → 返回 null", async () => {
    const run = await waitForSubagent("nope");
    expect(run).toBeNull();
  });

  it("detached running 超时 → 返回当前 status，不修改状态", async () => {
    vi.useFakeTimers();
    store.runs.set("r-detached", queuedRun({ id: "r-detached", status: "running" }));
    const p = waitForSubagent("r-detached", 300);
    // 推进超过 deadline + 一个轮询间隔（250ms），让 while 循环退出
    await vi.advanceTimersByTimeAsync(600);
    const run = await p;
    expect(run?.status).toBe("running");
    expect(store.runs.get("r-detached")?.status).toBe("running");
    vi.useRealTimers();
  });
});
