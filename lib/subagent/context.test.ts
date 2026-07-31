import type { SubagentDefinition, ToolRun } from "@/lib/db/schema";
import { describe, expect, it, vi } from "vitest";

/**
 * V3.5 Stage B：buildSubagentContextPackage 测试。
 *
 * 命门锁定：输出 messages 只含合成消息，不含父 Message 表原始历史。
 * 复用 V3.3a buildContextPackage（Infinity tokenBudget → 直通路径，不落库、不污染父摘要表）。
 */

// mock ContextSummary 持久化层（buildContextPackage 经此 import；直通路径不会调用，但 import 必须 resolve）
const summaryStore = vi.hoisted(() => ({ created: null as null | Record<string, unknown> }));
vi.mock("@/lib/db/queries", () => ({
  getActiveSummaryByChecksum: vi.fn(async () => null),
  createContextSummary: vi.fn(async (p: Record<string, unknown>) => {
    summaryStore.created = p;
    return { id: "s1", summaryText: p.summaryText, tokenEstimate: 0, originalTokenEstimate: 0 };
  }),
  listSummariesByThread: vi.fn(async () => []),
  supersedeSummary: vi.fn(async () => {}),
}));

import { buildSubagentContextPackage } from "./context";

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

describe("buildSubagentContextPackage 上下文隔离", () => {
  it("输出 messages 含 goal + contextHints，不含父历史", async () => {
    const pkg = await buildSubagentContextPackage({
      parentThreadId: "tid",
      goal: "找到所有路由文件",
      contextHints: ["路由在 app/api 下", "用 glob"],
      definition: def(),
      model: "gpt-x",
    });
    // 合成消息只有一条 user 消息
    expect(pkg.messages).toHaveLength(1);
    const text = JSON.stringify(pkg.messages);
    expect(text).toContain("找到所有路由文件");
    expect(text).toContain("路由在 app/api 下");
    // 不含父历史标记（合成消息不含父 Message 表内容）
    expect(text).not.toContain("父历史");
    expect(text).not.toContain("parent-message");
  });

  it("不触发压缩、不落 ContextSummary（Infinity budget → 直通）", async () => {
    summaryStore.created = null;
    await buildSubagentContextPackage({
      parentThreadId: "tid",
      goal: "g",
      definition: def(),
      model: "m",
    });
    expect(summaryStore.created).toBeNull();
  });

  it("includePlan 时注入父计划片段", async () => {
    const pkg = await buildSubagentContextPackage({
      parentThreadId: "tid",
      goal: "g",
      definition: def({ contextPolicy: { includePlan: true } }),
      activePlan: { id: "p1", title: "重构计划" } as never,
      planItems: [
        { id: "i1", status: "completed", title: "建路由" } as never,
        { id: "i2", status: "in_progress", title: "加测试" } as never,
      ],
      model: "m",
    });
    const text = JSON.stringify(pkg.messages);
    expect(text).toContain("重构计划");
    expect(text).toContain("加测试");
  });

  it("includeToolEvidence 时按 maxSnippets 裁剪注入工具证据", async () => {
    const evidence: ToolRun[] = Array.from(
      { length: 8 },
      (_, i) =>
        ({
          id: `tr-${i}`,
          toolName: "runCommand",
          status: "succeeded",
          input: { command: `cmd-${i}` },
          output: null,
        }) as unknown as ToolRun,
    );
    const pkg = await buildSubagentContextPackage({
      parentThreadId: "tid",
      goal: "g",
      definition: def({ contextPolicy: { includeToolEvidence: true, maxSnippets: 3 } }),
      recentToolEvidence: evidence,
      model: "m",
    });
    const text = JSON.stringify(pkg.messages);
    expect(text).toContain("cmd-0");
    expect(text).toContain("cmd-2");
    // maxSnippets=3 → cmd-3 及以后不注入
    expect(text).not.toContain("cmd-3");
  });

  it("includeHistory=false 时只含合成消息（零回归）", async () => {
    const pkg = await buildSubagentContextPackage({
      parentThreadId: "tid",
      goal: "g",
      definition: def({ contextPolicy: { includeHistory: false } }),
      parentHistorySummary: "父历史摘要",
      model: "m",
    });
    const text = JSON.stringify(pkg.messages);
    expect(text).not.toContain("父历史摘要");
  });

  it("includeHistory=true 且传入摘要时注入父历史摘要", async () => {
    const pkg = await buildSubagentContextPackage({
      parentThreadId: "tid",
      goal: "g",
      definition: def({ contextPolicy: { includeHistory: true } }),
      parentHistorySummary: "父历史摘要",
      model: "m",
    });
    const text = JSON.stringify(pkg.messages);
    expect(text).toContain("父历史摘要");
    expect(pkg.messages).toHaveLength(1);
  });
});
