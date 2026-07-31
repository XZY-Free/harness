import type { MemoryEntry } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { convertToModelMessages } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock ContextSummary 持久化层 ────────────────────────────
const summaryStore = vi.hoisted(() => ({
  active: null as null | { id: string; summaryText: string; tokenEstimate: number },
  createCalls: 0,
  created: null as null | Record<string, unknown>,
  /** 模拟已存在的活跃 turn summary 列表（供 supersede 测试）。 */
  activeList: [] as Array<{
    id: string;
    type: string;
    scope: { messageIds?: string[] } | null;
    supersededById: null;
  }>,
  superseded: [] as Array<{ oldId: string; newId: string }>,
}));

vi.mock("@/lib/db/queries", () => ({
  getActiveSummaryByChecksum: vi.fn(async () => summaryStore.active),
  createContextSummary: vi.fn(async (params: Record<string, unknown>) => {
    summaryStore.createCalls += 1;
    summaryStore.created = params;
    return {
      id: `sum-new-${summaryStore.createCalls}`,
      summaryText: params.summaryText,
      tokenEstimate: params.tokenEstimate,
      originalTokenEstimate: params.originalTokenEstimate,
    };
  }),
  listSummariesByThread: vi.fn(async () => summaryStore.activeList),
  supersedeSummary: vi.fn(async (p: { oldSummaryId: string; newSummaryId: string }) => {
    summaryStore.superseded.push({ oldId: p.oldSummaryId, newId: p.newSummaryId });
  }),
}));

import { assembleModelMessages, buildContextPackage } from "./package-builder";

function uiMsg(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    createdAt: new Date(),
  } as unknown as ChatMessage;
}

beforeEach(() => {
  summaryStore.active = null;
  summaryStore.createCalls = 0;
  summaryStore.created = null;
  summaryStore.activeList = [];
  summaryStore.superseded = [];
});

describe("buildContextPackage 零回归（低于预算逐字一致）", () => {
  it("Infinity 预算 → messages 与 convertToModelMessages(history) 逐字一致", async () => {
    const history = [
      uiMsg("m1", "user", "请实现登录页"),
      uiMsg("m2", "assistant", "好的，开始实现"),
      uiMsg("m3", "user", "用 Tailwind"),
    ];
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any-unconfigured",
      history,
      tokenBudget: Number.POSITIVE_INFINITY,
    });
    const direct = await convertToModelMessages(history);
    expect(pkg.compressed).toBe(false);
    expect(pkg.messages).toEqual(direct);
    expect(summaryStore.createCalls).toBe(0);
  });

  it("有预算但未超阈值 → 逐字一致 + compressed=false", async () => {
    const history = [uiMsg("m1", "user", "hi")];
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: 100_000, // 阈值 70000，hi 远低于
    });
    const direct = await convertToModelMessages(history);
    expect(pkg.compressed).toBe(false);
    expect(pkg.messages).toEqual(direct);
  });
});

describe("buildContextPackage 压缩路径", () => {
  it("超阈值 → compressed=true，旧消息被摘要替换，最新用户指令仍可见", async () => {
    // 构造超预算长 thread：很多长消息，budget 很小
    const history: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      history.push(uiMsg(`u${i}`, "user", `第 ${i} 轮指令 ${"x".repeat(200)}`));
      history.push(uiMsg(`a${i}`, "assistant", `第 ${i} 轮回复 ${"y".repeat(200)}`));
    }
    history.push(uiMsg("final", "user", "最终用户指令：完成登录页"));

    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: 100, // 阈值 70，远超
      recentKeepCount: 4,
    });

    expect(pkg.compressed).toBe(true);
    expect(summaryStore.createCalls).toBe(1);
    // 第一条是系统提供的上下文摘要，但不占用第二条 system 通道
    const first = pkg.messages[0];
    expect(first?.role).toBe("user");
    const contextContent = String((first as { content: string }).content);
    expect(contextContent).toContain("系统提供的历史上下文摘要");
    expect(contextContent).toContain("历史上下文摘要");
    // 最新用户指令逐字保留（在 kept 部分）
    const allText = pkg.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(allText).toContain("最终用户指令：完成登录页");
    // manifest 记录 appliedSummaryIds
    expect(pkg.manifest.appliedSummaryIds).toHaveLength(1);
    expect(pkg.manifest.beforeTokens).toBeGreaterThan(pkg.manifest.afterTokens);
  });

  it("checksum 命中 → 复用，不重复 createSummary", async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(uiMsg(`u${i}`, "user", `${"x".repeat(200)}`));
    }
    summaryStore.active = { id: "sum-existing", summaryText: "已有摘要", tokenEstimate: 5 };

    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: 50,
      recentKeepCount: 2,
    });

    expect(pkg.compressed).toBe(true);
    expect(summaryStore.createCalls).toBe(0); // 复用，不新建
    expect(pkg.manifest.appliedSummaryIds).toEqual(["sum-existing"]);
    const contextContent = String((pkg.messages[0] as { content: string } | undefined)?.content);
    expect(contextContent).toContain("已有摘要");
  });

  it("protected 注入：active plan / pending approval / recent failure 出现在装配消息", async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(uiMsg(`u${i}`, "user", `${"x".repeat(200)}`));
    }
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: 50,
      recentKeepCount: 2,
      activePlan: { id: "p1", threadId: "t1", title: "TDD 计划", status: "active" } as never,
      pendingApprovals: [
        {
          id: "a1",
          toolName: "deleteFile",
          permissionKey: "tool.deleteFile",
          argSummary: "path=old.ts",
        },
      ] as never,
      recentFailure: {
        toolName: "runCommand",
        status: "failed",
        input: { command: "npm test" },
        error: "timeout",
      } as never,
    });

    const contextContent = String((pkg.messages[0] as { content: string } | undefined)?.content);
    expect(contextContent).toContain("TDD 计划");
    expect(contextContent).toContain("deleteFile");
    expect(contextContent).toContain("npm test");
    expect(contextContent).toContain("timeout");
  });
});

describe("buildContextPackage Stage C 触发条件", () => {
  it("单工具输出超阈值 → 该 toolRun 摘要，即使总预算未超（Infinity）", async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) history.push(uiMsg(`u${i}`, "user", "x".repeat(50)));
    const oversizedOutput = { ok: true, stdout: "L".repeat(40_000) }; // > toolOutputThreshold(8192 tokens)
    const toolRuns = [
      {
        id: "tr-big",
        threadId: "t1",
        toolName: "runCommand",
        status: "succeeded",
        input: { command: "npm test" },
        output: oversizedOutput,
        error: null,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    ] as never;

    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: Number.POSITIVE_INFINITY, // 总预算未超
      toolRuns,
      recentKeepCount: 2,
    });

    expect(pkg.compressed).toBe(true);
    // 产出 toolRun 类型摘要
    const toolRunSummary = pkg.manifest.summaries.find(
      (s) => s.type === "toolRun" || s.type === "diff",
    );
    expect(toolRunSummary).toBeTruthy();
    const contextContent = String((pkg.messages[0] as { content: string } | undefined)?.content);
    expect(contextContent).toContain("npm test");
  });

  it("plan 阶段切换 → decisionLog 摘要", async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) history.push(uiMsg(`u${i}`, "user", "x".repeat(50)));
    const planEvents = [
      {
        id: "e1",
        threadId: "t1",
        sequence: 1,
        type: "plan.item_updated",
        payload: { itemId: "i1", status: "failed", title: "直接改" },
        createdAt: new Date(),
      },
    ] as never;

    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: Number.POSITIVE_INFINITY,
      planEvents,
      recentKeepCount: 2,
    });

    expect(pkg.compressed).toBe(true);
    const decision = pkg.manifest.summaries.find((s) => s.type === "decision");
    expect(decision).toBeTruthy();
    const contextContent = String((pkg.messages[0] as { content: string } | undefined)?.content);
    expect(contextContent).toContain("直接改");
  });

  it("supersede：新 turn 摘要覆盖旧 turn 摘要 scope → 旧 summary 被 supersede", async () => {
    // 旧 turn summary 覆盖 u0,u1
    summaryStore.activeList = [
      { id: "old-turn", type: "turn", scope: { messageIds: ["u0", "u1"] }, supersededById: null },
    ];
    const history: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) history.push(uiMsg(`u${i}`, "user", "x".repeat(200)));
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: 50, // 触发压缩
      recentKeepCount: 2,
    });

    expect(pkg.compressed).toBe(true);
    // 新 turn summary 覆盖 u0..u7（排除最近 2 条），是 old-turn(u0,u1) 的超集 → supersede
    const supersedeCall = summaryStore.superseded.find((s) => s.oldId === "old-turn");
    expect(supersedeCall).toBeTruthy();
    expect(pkg.manifest.appliedSummaryIds).toContain(supersedeCall?.newId);
  });
});

describe("buildContextPackage Stage D 硬不变式（六类 protected 压缩后存活）", () => {
  it("超预算压缩后，六类 protected 项仍出现在装配 messages", async () => {
    // 构造超预算长 thread
    const history: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      history.push(uiMsg(`u${i}`, "user", `第${i}轮 ${"x".repeat(200)}`));
      history.push(uiMsg(`a${i}`, "assistant", `回复${i} ${"y".repeat(200)}`));
    }
    // 最后一条用户消息（最新用户指令）
    history.push(uiMsg("latest-user", "user", "最终指令：完成登录页并用 Tailwind"));

    const pkg = await buildContextPackage({
      threadId: "t-invariant",
      model: "any",
      history,
      tokenBudget: 100, // 阈值 70，远超
      recentKeepCount: 4,
      activePlan: {
        id: "p1",
        threadId: "t-invariant",
        title: "登录页计划",
        status: "active",
      } as never,
      pendingApprovals: [
        {
          id: "a1",
          toolName: "deleteFile",
          permissionKey: "tool.deleteFile",
          argSummary: "path=old.ts",
        },
      ] as never,
      recentFailure: {
        toolName: "runCommand",
        status: "failed",
        input: { command: "npm test" },
        error: "timeout-xyz",
      } as never,
      policyConstraints: ["禁止删除 src/protected", "部署需审批"],
      pinnedFacts: ["必须用 Tailwind", "端口固定 3000"],
    });

    expect(pkg.compressed).toBe(true);
    const allText = pkg.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    // 1. 最新用户指令（逐字，在 kept 部分）
    expect(allText).toContain("最终指令：完成登录页并用 Tailwind");
    // 2. active plan
    expect(allText).toContain("登录页计划");
    // 3. pending approval
    expect(allText).toContain("deleteFile");
    expect(allText).toContain("path=old.ts");
    // 4. 最近失败原始错误片段
    expect(allText).toContain("npm test");
    expect(allText).toContain("timeout-xyz");
    // 5. 安全/权限/部署硬约束
    expect(allText).toContain("禁止删除 src/protected");
    expect(allText).toContain("部署需审批");
    // 6. pinned facts
    expect(allText).toContain("必须用 Tailwind");
    expect(allText).toContain("端口固定 3000");
  });
});

describe("assembleModelMessages fail-safe 回退", () => {
  it("builder 抛错 → 回退直通 convertToModelMessages，fallback=true", async () => {
    const history = [uiMsg("m1", "user", "hi"), uiMsg("m2", "assistant", "yo")];
    const result = await assembleModelMessages({
      threadId: "t1",
      history,
      build: async () => {
        throw new Error("builder boom");
      },
    });
    expect(result.fallback).toBe(true);
    expect(result.compressed).toBe(false);
    expect(result.messages).toEqual(await convertToModelMessages(history));
  });

  it("builder 正常 → fallback=false，返回 manifest", async () => {
    const history = [uiMsg("m1", "user", "hi")];
    const result = await assembleModelMessages({
      threadId: "t1",
      history,
      build: async () =>
        buildContextPackage({
          threadId: "t1",
          model: "any",
          history,
          tokenBudget: Number.POSITIVE_INFINITY,
        }),
    });
    expect(result.fallback).toBe(false);
    expect(result.manifest).toBeTruthy();
    expect(result.manifest?.appliedSummaryIds).toEqual([]);
  });
});

// ─── V3.3b Stage C：memory 注入（零回归 + 预算裁剪 + excludedCandidates）───

function memRow(id: string, text: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    scope: "project",
    scopeRef: "p1",
    kind: "convention",
    text,
    textHash: `h-${id}`,
    provenance: [{ kind: "user", refId: "u1" }],
    confidence: "medium",
    status: "active",
    expiresAt: null,
    createdByToolRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as MemoryEntry;
}

function longHistoryC(n: number, finalText = "最终用户指令：完成登录页"): ChatMessage[] {
  const h: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    h.push(uiMsg(`u${i}`, "user", `第 ${i} 轮指令 ${"x".repeat(200)}`));
    h.push(uiMsg(`a${i}`, "assistant", `第 ${i} 轮回复 ${"y".repeat(200)}`));
  }
  h.push(uiMsg("final", "user", finalText));
  return h;
}

describe("buildContextPackage V3.3b memory 注入（Stage C）", () => {
  it("零回归：无 memory（undefined）→ 与 convertToModelMessages 逐字一致", async () => {
    const history = [uiMsg("m1", "user", "hi"), uiMsg("m2", "assistant", "hello")];
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: Number.POSITIVE_INFINITY,
    });
    const direct = await convertToModelMessages(history);
    expect(pkg.messages).toEqual(direct);
    expect(pkg.manifest.excludedCandidates).toEqual([]);
  });

  it("无压缩 + memory → memory wrapper（role:user，非 system），标记 memory-derived", async () => {
    const history = [uiMsg("m1", "user", "hi")];
    const memories = [memRow("mem1", "commit 用 Lore trailer")];
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: Number.POSITIVE_INFINITY,
      memories,
    });
    expect(pkg.compressed).toBe(false);
    expect(pkg.messages[0]?.role).toBe("user");
    const wrapperText = String((pkg.messages[0] as { content: unknown }).content);
    expect(wrapperText).toContain("长期记忆");
    expect(wrapperText).toContain("memory-derived");
    expect(wrapperText).toContain("commit 用 Lore trailer");
    // 不新增 system message
    expect(pkg.messages.filter((m) => m.role === "system")).toHaveLength(0);
  });

  it("压缩 + memory → memory 段在摘要 wrapper（protected 前），标记 memory-derived", async () => {
    const history = longHistoryC(8, "最终用户指令：完成登录页");
    const oversizedOutput = { ok: true, stdout: "L".repeat(40_000) };
    const toolRuns = [
      {
        id: "tr-big",
        threadId: "t1",
        toolName: "runCommand",
        status: "succeeded",
        input: { command: "npm test" },
        output: oversizedOutput,
        error: null,
        startedAt: new Date(),
        finishedAt: new Date(),
      } as never,
    ];
    const memories = [memRow("mem1", "commit 用 Lore trailer")];
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: Number.POSITIVE_INFINITY, // Infinity 不裁 memory，oversized 触发压缩
      toolRuns,
      memories,
      pinnedFacts: ["硬约束X"],
    });
    expect(pkg.compressed).toBe(true);
    const wrapperText = String((pkg.messages[0] as { content: unknown }).content);
    expect(wrapperText).toContain("长期记忆");
    expect(wrapperText).toContain("memory-derived");
    const memIdx = wrapperText.indexOf("长期记忆");
    const protIdx = wrapperText.indexOf("受保护上下文");
    expect(memIdx).toBeGreaterThan(-1);
    expect(protIdx).toBeGreaterThan(memIdx);
    expect(wrapperText).toContain("硬约束X");
  });

  it("预算裁剪：超 budget 先裁 memory，进 excludedCandidates，protected 不动", async () => {
    const history = longHistoryC(8, "最终用户指令");
    const memories = [
      memRow("mem1", "commit 用 Lore trailer one"),
      memRow("mem2", "commit 用 Lore trailer two"),
      memRow("mem3", "commit 用 Lore trailer three"),
    ];
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: 60,
      recentKeepCount: 2,
      memories,
      pinnedFacts: ["硬约束Y"],
    });
    expect(pkg.compressed).toBe(true);
    const excluded = pkg.manifest.excludedCandidates.filter((c) => c.kind === "memory");
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.every((c) => c.reason === "预算裁剪")).toBe(true);
    // protected refs 不被裁（pinned_fact 仍在）
    const kinds = pkg.manifest.protectedRefs.map((r) => r.kind);
    expect(kinds).toContain("pinned_fact");
  });

  it("无 memory 压缩路径 → excludedCandidates 空（不伪造裁剪）", async () => {
    const history = longHistoryC(6);
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: 100,
      recentKeepCount: 4,
    });
    expect(pkg.compressed).toBe(true);
    expect(pkg.manifest.excludedCandidates).toEqual([]);
  });
});

describe("V6-M2-4: microcompact 裁剪 tool-result part", () => {
  it("tool-result string output 超 microcompact token cap → 被截断", async () => {
    // 构造包含超大 tool-result output 的 history
    // microcompactMessageTokens 默认 2048；ASCII fallback = char/4 → 需要 > 8192 字符
    const largeOutput = "x".repeat(9000); // ~2250 tokens（超过 2048 cap）
    const history: ChatMessage[] = [
      uiMsg("m1", "user", "请分析"),
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "tool-call", toolCallId: "tc1", toolName: "analyze", input: {} }],
        createdAt: new Date(),
      } as unknown as ChatMessage,
      {
        id: "m3",
        role: "user",
        parts: [
          { type: "tool-result", toolCallId: "tc1", toolName: "analyze", output: largeOutput },
        ],
        createdAt: new Date(),
      } as unknown as ChatMessage,
      uiMsg("m4", "user", "请总结"),
    ];

    // tokenBudget 设置使得 soft 触发但 budget 不触发
    // 总 token ≈ 2250（tool-result）+ ~30（其余）≈ 2280
    // soft(0.5) → 4000 * 0.5 = 2000 < 2280 ✓
    // budget(0.7) → 4000 * 0.7 = 2800 > 2280 ✓
    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: 4000,
    });

    // microcompact 触发但不整体压缩
    expect(pkg.compressed).toBe(false);

    // 转换后消息中不应包含完整的 9000 字符原始 output
    const allContent = JSON.stringify(pkg.messages);
    expect(allContent).not.toContain(largeOutput.slice(0, 200));
  });

  it("tool-result object output 超 cap → 被替换为截断标记", async () => {
    const largeObject = { data: "y".repeat(9000), nested: { extra: "z".repeat(1000) } };
    const history: ChatMessage[] = [
      uiMsg("m1", "user", "run"),
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "tool-call", toolCallId: "tc1", toolName: "analyze", input: {} }],
        createdAt: new Date(),
      } as unknown as ChatMessage,
      {
        id: "m3",
        role: "user",
        parts: [
          { type: "tool-result", toolCallId: "tc1", toolName: "analyze", output: largeObject },
        ],
        createdAt: new Date(),
      } as unknown as ChatMessage,
      uiMsg("m4", "user", "summary"),
    ];

    const pkg = await buildContextPackage({
      threadId: "t1",
      model: "any",
      history,
      tokenBudget: 4000,
    });

    expect(pkg.compressed).toBe(false);
    // object 类型 output 被替换为 { result: "Output truncated..." }
    const allContent = JSON.stringify(pkg.messages);
    expect(allContent).not.toContain("y".repeat(200));
  });
});
