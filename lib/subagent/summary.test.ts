import type { SubagentDefinition, SubagentRun } from "@/lib/db/schema";
import { describe, expect, it, vi } from "vitest";

/**
 * V3.5 Stage D：buildSubagentSummary / renderSubagentSummaries 测试。
 *
 * 锁定：summary 含 role/goal/status/resultSummary，不含 transcript 正文（只引用路径）；
 * renderSubagentSummaries 拼成父 context layer 文本，空列表零回归。
 */

// getDefinition mock（buildSubagentSummary 按 definitionId 取 role）
vi.mock("@/lib/subagent/registry", () => ({
  getDefinition: vi.fn(async (id: string) =>
    id === "def-1"
      ? ({
          id: "def-1",
          name: "explore",
          role: "explore",
        } as unknown as SubagentDefinition)
      : null,
  ),
}));

import { buildSubagentSummary, renderSubagentSummaries } from "./summary";

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "run-1",
    parentThreadId: "tid",
    definitionId: "def-1",
    goal: "找到路由文件",
    contextHints: null,
    status: "completed",
    writeScope: null,
    resultSummary: "找到 3 个：app/api/a.ts, b.ts, c.ts",
    outputArtifactId: "art-1",
    transcriptPath: ".snow/runtime/tid/subagents/run-1/transcript.json",
    errorMessage: null,
    startedAt: new Date(),
    finishedAt: new Date(),
    createdAt: new Date(),
    ...over,
  };
}

describe("buildSubagentSummary", () => {
  it("含 role/goal/status/resultSummary", async () => {
    const s = await buildSubagentSummary(run());
    expect(s.role).toBe("explore");
    expect(s.goal).toBe("找到路由文件");
    expect(s.status).toBe("completed");
    expect(s.resultSummary).toContain("找到 3 个");
  });

  it("不含 transcript 正文，只引用 transcriptPath/outputArtifactId", async () => {
    const s = await buildSubagentSummary(run());
    expect(s.evidenceRefs).toContain("art-1");
    expect(s.evidenceRefs).toContain(".snow/runtime/tid/subagents/run-1/transcript.json");
    // transcript 正文不在 SubagentRun 上（只有 transcriptPath 路径引用），summary 结构上无法泄露内容
    expect(s.text).toContain("找到 3 个");
  });

  it("definition 查不到 → role 为空但不抛", async () => {
    const s = await buildSubagentSummary(run({ definitionId: "missing" }));
    expect(s.role).toBe("");
    expect(s.goal).toBe("找到路由文件");
  });

  it("failed run → handoff 提示重试", async () => {
    const s = await buildSubagentSummary(
      run({ status: "failed", resultSummary: null, errorMessage: "boom" }),
    );
    expect(s.handoff).toContain("重试");
    expect(s.text).toContain("boom");
  });
});

describe("renderSubagentSummaries", () => {
  it("空列表 → 空串（零回归）", () => {
    expect(renderSubagentSummaries([])).toBe("");
  });

  it("含 summary 文本 → 拼成 context layer 段，含标记与结果摘要", async () => {
    const s = await buildSubagentSummary(run());
    const rendered = renderSubagentSummaries([s]);
    expect(rendered).toContain("子代理结果汇总");
    expect(rendered).toContain("找到 3 个");
    // transcript 内容不在 run 上；路径仅作证据引用（设计允许）
    expect(rendered).toContain("art-1");
  });

  it("父 context layer 只见 summary 不见 transcript（多个子代理）", async () => {
    const s1 = await buildSubagentSummary(run({ id: "r1", resultSummary: "结果 A" }));
    const s2 = await buildSubagentSummary(
      run({ id: "r2", resultSummary: "结果 B", transcriptPath: ".snow/.../r2/transcript.json" }),
    );
    const rendered = renderSubagentSummaries([s1, s2]);
    expect(rendered).toContain("结果 A");
    expect(rendered).toContain("结果 B");
    // transcript 内容不在 run 上，layer 只含 summary；路径仅作证据引用
    expect(rendered).toContain("子代理结果汇总");
  });
});
