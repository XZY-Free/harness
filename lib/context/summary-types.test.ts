import type { ThreadPlanItem, ToolRun } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { describe, expect, it } from "vitest";
import {
  SUMMARY_TYPES,
  extractDebugSummary,
  extractDiffSummary,
  extractToolRunSummary,
  extractTurnSummary,
  isDiffToolRun,
} from "./summary-types";

function toolRun(over: Partial<ToolRun> & { toolName: string }): ToolRun {
  return {
    id: "tr1",
    threadId: "tid",
    status: "succeeded",
    input: {},
    output: null,
    error: null,
    startedAt: new Date(),
    finishedAt: null,
    ...over,
  } as ToolRun;
}

function uiMsg(role: "user" | "assistant", text: string): ChatMessage {
  return {
    id: "m1",
    role,
    parts: [{ type: "text", text }],
    createdAt: new Date(),
  } as unknown as ChatMessage;
}

describe("extractToolRunSummary", () => {
  it("提取 runCommand 的命令/退出码/产物", () => {
    const s = extractToolRunSummary(
      toolRun({
        toolName: "runCommand",
        input: { command: "npm test" },
        output: { ok: true, exitCode: 0, stdout: "", stderr: "", command: "npm test" },
      }),
    );
    expect(s.command).toBe("npm test");
    expect(s.exitCode).toBe(0);
    expect(s.error).toBeNull();
    expect(s.text).toContain("命令: npm test");
    expect(s.text).toContain("退出码: 0");
  });

  it("失败 toolRun 提取错误且退出码 -1", () => {
    const s = extractToolRunSummary(
      toolRun({
        toolName: "runCommand",
        status: "failed",
        input: { command: "npm run build" },
        output: null,
        error: "timeout",
      }),
    );
    expect(s.exitCode).toBe(-1);
    expect(s.error).toBe("timeout");
    expect(s.text).toContain("错误: timeout");
  });

  it("产物引用从 input.path / output.path 提取", () => {
    const s = extractToolRunSummary(
      toolRun({
        toolName: "readFile",
        input: { path: "src/a.ts" },
        output: { ok: true, path: "src/a.ts", content: "x" },
      }),
    );
    expect(s.artifacts).toEqual(["src/a.ts", "src/a.ts"]);
  });
});

describe("extractDiffSummary", () => {
  it("writeFile → action=write", () => {
    const s = extractDiffSummary(
      toolRun({
        toolName: "writeFile",
        input: { path: "src/main.ts", content: "x" },
        output: { ok: true, path: "src/main.ts", bytes: 1 },
      }),
    );
    expect(s.action).toBe("write");
    expect(s.path).toBe("src/main.ts");
    expect(s.risks).toEqual([]);
  });

  it("deleteFile → action=delete 且有不可逆风险", () => {
    const s = extractDiffSummary(
      toolRun({
        toolName: "deleteFile",
        input: { path: "old.ts" },
        output: { ok: true },
      }),
    );
    expect(s.action).toBe("delete");
    expect(s.risks).toContain("删除文件不可逆");
  });

  it("大文件覆盖触发风险点", () => {
    const s = extractDiffSummary(
      toolRun({
        toolName: "writeFile",
        input: { path: "big.ts", content: "x".repeat(30_000) },
        output: { ok: true },
      }),
    );
    expect(s.risks).toContain("覆盖大文件");
  });
});

describe("extractDebugSummary", () => {
  it("连续同一命令失败 → 已排除假设", () => {
    const s = extractDebugSummary([
      toolRun({
        toolName: "runCommand",
        status: "failed",
        input: { command: "npm test" },
        error: "e1",
      }),
      toolRun({
        toolName: "runCommand",
        status: "failed",
        input: { command: "npm test" },
        error: "e2",
      }),
    ]);
    expect(s.failedCommands).toHaveLength(2);
    expect(s.excludedHypotheses).toContain("「npm test」仍未解决问题");
    expect(s.nextStep).toBe("换一种思路，避免重复已排除的路径");
  });

  it("无失败记录 → nextStep 兜底", () => {
    const s = extractDebugSummary([]);
    expect(s.nextStep).toBe("无失败记录");
  });
});

describe("extractTurnSummary", () => {
  it("提取用户目标首句 + 指令动词", () => {
    const s = extractTurnSummary({
      messages: [uiMsg("user", "请实现一个登录页面。另外修复样式。")],
    });
    expect(s.userGoal).toBe("请实现一个登录页面");
    expect(s.imperativeVerb).toBe("实现");
  });

  it("从 planItems 推断未决问题", () => {
    const items = [
      { title: "写测试", status: "pending" },
      { title: "跑构建", status: "failed" },
      { title: "已完成项", status: "completed" },
    ] as ThreadPlanItem[];
    const s = extractTurnSummary({
      messages: [uiMsg("user", "创建项目")],
      planItems: items,
    });
    expect(s.openQuestions).toContain("写测试 [pending]");
    expect(s.openQuestions).toContain("跑构建 [failed]");
    expect(s.openQuestions).not.toContain("已完成项 [completed]");
  });

  it("状态切换原因被记录", () => {
    const s = extractTurnSummary({
      messages: [uiMsg("user", "修复 bug")],
      statusChanges: [{ reason: "chat_started", from: "idle", to: "executing" }],
    });
    expect(s.stateTransitions).toContain("chat_started");
  });

  // S1 修复（03-P1-1）：turn 摘要保留工具调用证据
  it("提取 tool-call 证据（toolName + 入参摘要 + 结果状态）", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "我来读文件" },
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "readFile",
            input: { path: "src/main.ts" },
          },
        ],
        createdAt: new Date(),
      },
      {
        id: "u1",
        role: "user",
        parts: [{ type: "tool-result", toolCallId: "tc1", output: { ok: true, content: "..." } }],
        createdAt: new Date(),
      },
    ] as unknown as ChatMessage[];
    const s = extractTurnSummary({ messages });
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0]?.toolName).toBe("readFile");
    expect(s.toolCalls[0]?.inputSummary).toBe("src/main.ts");
    expect(s.toolCalls[0]?.resultStatus).toBe("success");
    // 摘要正文含工具证据
    expect(s.text).toContain("readFile");
  });

  it("tool-result 失败 → resultStatus=failed", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "runCommand",
            input: { command: "npm test" },
          },
        ],
        createdAt: new Date(),
      },
      {
        id: "u1",
        role: "user",
        parts: [{ type: "tool-result", toolCallId: "tc1", output: { ok: false, exitCode: 1 } }],
        createdAt: new Date(),
      },
    ] as unknown as ChatMessage[];
    const s = extractTurnSummary({ messages });
    expect(s.toolCalls[0]?.resultStatus).toBe("failed");
  });

  // S1 修复（03-P1-2）：最后一条 user 是 tool-result carrier 时仍找到真实用户目标
  it("最后 user 消息是 tool-result carrier（无 text）→ 回溯找含 text 的 user 消息", () => {
    const messages = [
      uiMsg("user", "请修复登录页样式"),
      uiMsg("assistant", "好的"),
      {
        id: "u2",
        role: "user",
        parts: [{ type: "tool-result", toolCallId: "tc1", output: { ok: true } }],
        createdAt: new Date(),
      },
    ] as unknown as ChatMessage[];
    const s = extractTurnSummary({ messages });
    // 不为空：回溯到第一条含 text 的 user 消息
    expect(s.userGoal).toBe("请修复登录页样式");
  });
});

describe("类型注册表", () => {
  it("六种类型齐全，subagent 在列", () => {
    expect(SUMMARY_TYPES).toEqual(["turn", "toolRun", "diff", "debug", "decision", "subagent"]);
  });
});

describe("isDiffToolRun", () => {
  it("writeFile/applyPatch/multiEditFile/deleteFile 为变更类", () => {
    expect(isDiffToolRun(toolRun({ toolName: "writeFile" }))).toBe(true);
    expect(isDiffToolRun(toolRun({ toolName: "deleteFile" }))).toBe(true);
    expect(isDiffToolRun(toolRun({ toolName: "runCommand" }))).toBe(false);
  });
});
