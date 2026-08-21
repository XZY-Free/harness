import type { ThreadPlan, ToolApprovalRequest, ToolRun } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { describe, expect, it } from "vitest";
import { computeProtectedRefs, renderInjectedProtected } from "./protected-refs";

function uiMsg(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    createdAt: new Date(),
  } as unknown as ChatMessage;
}

const plan = { id: "p1", threadId: "t", title: "TDD 方案", status: "active" } as ThreadPlan;
const approval = {
  id: "a1",
  threadId: "t",
  toolRunId: "tr",
  toolName: "deleteFile",
  permissionKey: "tool.deleteFile",
  argFingerprint: "x",
  argSummary: "path=old.ts",
  status: "pending",
} as unknown as ToolApprovalRequest;
const failure = {
  id: "tr1",
  threadId: "t",
  toolName: "runCommand",
  status: "failed",
  input: { command: "npm test" },
  output: null,
  error: "timeout",
} as unknown as ToolRun;

describe("computeProtectedRefs", () => {
  it("最新用户消息 id 进入 protectedMessageIds", () => {
    const msgs = [
      uiMsg("m1", "user", "开始"),
      uiMsg("m2", "assistant", "好的"),
      uiMsg("m3", "user", "继续"),
    ];
    const r = computeProtectedRefs({ messages: msgs });
    expect(r.protectedMessageIds.has("m3")).toBe(true);
    expect(r.refs.some((x) => x.kind === "latest_user")).toBe(true);
  });

  it("最近 N 条原始消息全部保留", () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      uiMsg(`m${i}`, i % 2 ? "assistant" : "user", `msg${i}`),
    );
    const r = computeProtectedRefs({ messages: msgs, recentKeepCount: 4 });
    // 最近 4 条都在 protected 集合里
    expect(["m6", "m7", "m8", "m9"].every((id) => r.protectedMessageIds.has(id))).toBe(true);
    expect(r.protectedMessageIds.has("m0")).toBe(false);
  });

  it("active plan 注入为 protected 文本", () => {
    const r = computeProtectedRefs({ messages: [uiMsg("m1", "user", "hi")], activePlan: plan });
    expect(r.injected.some((p) => p.kind === "active_plan" && p.text.includes("TDD 方案"))).toBe(
      true,
    );
  });

  it("pending approval 全部注入", () => {
    const r = computeProtectedRefs({
      messages: [uiMsg("m1", "user", "hi")],
      pendingApprovals: [approval, { ...approval, id: "a2" } as unknown as ToolApprovalRequest],
    });
    const ap = r.injected.find((p) => p.kind === "pending_approval");
    expect(ap).toBeTruthy();
    expect(ap?.text).toContain("deleteFile");
  });

  it("recent failure 注入原始错误片段", () => {
    const r = computeProtectedRefs({
      messages: [uiMsg("m1", "user", "hi")],
      recentFailure: failure,
    });
    const rf = r.injected.find((p) => p.kind === "recent_failure");
    expect(rf?.text).toContain("npm test");
    expect(rf?.text).toContain("timeout");
  });

  it("无 active plan / approval / failure 时 injected 为空", () => {
    const r = computeProtectedRefs({ messages: [uiMsg("m1", "user", "hi")] });
    expect(r.injected).toEqual([]);
  });
});

// ── P0-2 tool-call/tool-result 配对回填 ──────────────────────────────

/** 构造含 tool-call part 的 assistant 消息（模拟 AI SDK v6 UIMessage 结构）。 */
function assistantToolCallMsg(id: string, toolCallId: string, toolName: string): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text: `调用 ${toolName}` },
      { type: "tool-call", toolCallId, toolName, input: { path: "a.ts" } },
    ],
    createdAt: new Date(),
  } as unknown as ChatMessage;
}

/** 构造含 tool-result part 的 user 消息（模拟 AI SDK v6 UIMessage 结构）。 */
function userToolResultMsg(id: string, toolCallId: string): ChatMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "tool-result", toolCallId, output: { ok: true, path: "a.ts" } }],
    createdAt: new Date(),
  } as unknown as ChatMessage;
}

describe("computeProtectedRefs · P0-2 tool-call/tool-result 配对回填", () => {
  it("kept 中保留 tool-result 时，对应 tool-call 被回填保留", () => {
    // history: user → assistant(tool-call tc1) → user(tool-result tc1) → user(最终指令)
    // recentKeepCount=2 → 保留末两条：user(tool-result) + user(最终指令)
    // tool-result 在 protected，但 tool-call 不在 → 应回填 tool-call
    const msgs = [
      uiMsg("u1", "user", "开始"),
      assistantToolCallMsg("a1", "tc1", "writeFile"),
      userToolResultMsg("u2", "tc1"),
      uiMsg("u3", "user", "最终指令"),
    ];
    const r = computeProtectedRefs({ messages: msgs, recentKeepCount: 2 });
    expect(r.protectedMessageIds.has("u3")).toBe(true); // 最新 user
    expect(r.protectedMessageIds.has("u2")).toBe(true); // tool-result（在最近 2 条内）
    expect(r.protectedMessageIds.has("a1")).toBe(true); // tool-call 回填
    expect(r.refs.some((x) => x.kind === "tool_pair_backfill")).toBe(true);
  });

  it("kept 中保留 tool-call 时，对应 tool-result 被回填保留", () => {
    // history: user → assistant(tool-call tc1) → user(tool-result tc1) → assistant(回复) → user(最终)
    // recentKeepCount=3 → 保留末三条：assistant(回复) + user(最终) + ?
    // 设计：让 tool-call 在最近 3 条内，tool-result 不在
    const msgs = [
      uiMsg("u1", "user", "开始"),
      userToolResultMsg("u2", "tc1"), // tool-result 在前
      assistantToolCallMsg("a1", "tc1", "writeFile"), // tool-call 紧随其后
      uiMsg("u3", "assistant", "已处理"),
      uiMsg("u4", "user", "最终指令"),
    ];
    // recentKeepCount=3 → 保留 a1(tc1 call) + u3 + u4，但 u2(result) 不在
    const r = computeProtectedRefs({ messages: msgs, recentKeepCount: 3 });
    expect(r.protectedMessageIds.has("a1")).toBe(true); // tool-call 在最近 3 条
    expect(r.protectedMessageIds.has("u2")).toBe(true); // tool-result 回填
  });

  it("无配对的孤儿 tool-call 不触发回填（无对应 tool-result）", () => {
    // tool-call 无对应 tool-result（agent 中途中断）→ 不应误把无关消息拉入
    const msgs = [
      uiMsg("u1", "user", "开始"),
      assistantToolCallMsg("a1", "orphan-tc", "writeFile"), // 无对应 result
      uiMsg("u2", "user", "最终指令"),
    ];
    const r = computeProtectedRefs({ messages: msgs, recentKeepCount: 1 });
    // recentKeepCount=1 → 只保留 u2（最新 user）
    expect(r.protectedMessageIds.has("u2")).toBe(true);
    expect(r.protectedMessageIds.has("a1")).toBe(false); // 孤儿 tool-call 不回填
    expect(r.refs.some((x) => x.kind === "tool_pair_backfill")).toBe(false);
  });

  it("多组配对同时回填（迭代稳定）", () => {
    // 两组 tool-call/tool-result 交错，recentKeepCount 让部分在 protected 部分不在
    const msgs = [
      uiMsg("u0", "user", "开始"),
      assistantToolCallMsg("a1", "tc1", "writeFile"),
      userToolResultMsg("u1", "tc1"),
      assistantToolCallMsg("a2", "tc2", "runCommand"),
      userToolResultMsg("u2", "tc2"),
      uiMsg("u3", "user", "最终指令"),
    ];
    // recentKeepCount=2 → 保留 u2(tc2 result) + u3
    // u2 是 tc2 的 result → 回填 a2(tc2 call)
    // a2 不引入新配对需求（tc2 已配对）
    // tc1 全部不在 protected → 不回填
    const r = computeProtectedRefs({ messages: msgs, recentKeepCount: 2 });
    expect(r.protectedMessageIds.has("u3")).toBe(true);
    expect(r.protectedMessageIds.has("u2")).toBe(true); // tc2 result 在最近 2 条
    expect(r.protectedMessageIds.has("a2")).toBe(true); // tc2 call 回填
    expect(r.protectedMessageIds.has("a1")).toBe(false); // tc1 call 不在
    expect(r.protectedMessageIds.has("u1")).toBe(false); // tc1 result 不在
  });
});

describe("renderInjectedProtected", () => {
  it("空数组 → 空串", () => {
    expect(renderInjectedProtected([])).toBe("");
  });
  it("多项拼接", () => {
    const text = renderInjectedProtected([
      { kind: "active_plan", text: "当前计划: A" },
      { kind: "recent_failure", text: "最近失败: X" },
    ]);
    expect(text).toBe("当前计划: A\n最近失败: X");
  });
});

// ─── Stage D：policy constraints + pinned facts ──────────────

describe("computeProtectedRefs Stage D（policy / pinned facts）", () => {
  it("policy constraints 注入为 protected", () => {
    const r = computeProtectedRefs({
      messages: [uiMsg("m1", "user", "hi")],
      policyConstraints: ["禁止删除 src/", "部署需审批"],
    });
    const pc = r.injected.find((p) => p.kind === "policy_constraint");
    expect(pc?.text).toContain("禁止删除 src/");
    expect(pc?.text).toContain("部署需审批");
  });

  it("pinned facts 注入为 protected", () => {
    const r = computeProtectedRefs({
      messages: [uiMsg("m1", "user", "hi")],
      pinnedFacts: ["必须用 Tailwind", "端口固定 3000"],
    });
    const pf = r.injected.find((p) => p.kind === "pinned_fact");
    expect(pf?.text).toContain("必须用 Tailwind");
    expect(pf?.text).toContain("端口固定 3000");
  });

  it("六类 protected refs 全部识别时 refs 完整", () => {
    const r = computeProtectedRefs({
      messages: [uiMsg("m1", "user", "hi")],
      activePlan: plan,
      pendingApprovals: [approval],
      recentFailure: failure,
      policyConstraints: ["硬约束A"],
      pinnedFacts: ["pinnedA"],
    });
    const kinds = new Set(r.refs.map((x) => x.kind));
    expect(kinds.has("latest_user")).toBe(true);
    expect(kinds.has("active_plan")).toBe(true);
    expect(kinds.has("pending_approval")).toBe(true);
    expect(kinds.has("recent_failure")).toBe(true);
    expect(kinds.has("policy_constraint")).toBe(true);
    expect(kinds.has("pinned_fact")).toBe(true);
  });
});
