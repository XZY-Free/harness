import type { ChatMessage } from "@/lib/types";
import { describe, expect, it } from "vitest";
import {
  computeContextWindowStatus,
  countMessagesTokens,
  countTokens,
  estimateMessagesTokens,
  estimateTokens,
  resolveTokenBudget,
  shouldCompress,
} from "./budget";

function uiMsg(role: "user" | "assistant", text: string): ChatMessage {
  return {
    id: "m",
    role,
    parts: [{ type: "text", text }],
    createdAt: new Date(),
  } as unknown as ChatMessage;
}

describe("estimateTokens", () => {
  it("char/4 向上取整（tokenizer 未加载时用 CJK 回退）", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("resolveTokenBudget", () => {
  it("未配置 contextWindow 的 model → Infinity（永不压缩，零回归）", () => {
    expect(resolveTokenBudget("unconfigured-model")).toBe(Number.POSITIVE_INFINITY);
  });

  it("配置过的 model → 返回窗口值", () => {
    const original = process.env.SNOW_CONTEXT_WINDOWS;
    process.env.SNOW_CONTEXT_WINDOWS = JSON.stringify({ "test-model-1": 131072 });
    expect(resolveTokenBudget("test-model-1")).toBe(131072);
    process.env.SNOW_CONTEXT_WINDOWS = original;
  });

  it("非法 JSON → 回退空 map → Infinity", () => {
    const original = process.env.SNOW_CONTEXT_WINDOWS;
    process.env.SNOW_CONTEXT_WINDOWS = "{not json";
    expect(resolveTokenBudget("any")).toBe(Number.POSITIVE_INFINITY);
    process.env.SNOW_CONTEXT_WINDOWS = original;
  });
});

describe("shouldCompress", () => {
  it("Infinity 预算 → 恒 false（零回归核心）", () => {
    expect(shouldCompress(1_000_000, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("低于阈值 → false", () => {
    // budget 1000, threshold 0.7 → 触发线 700
    expect(shouldCompress(500, 1000, 0.7)).toBe(false);
    expect(shouldCompress(700, 1000, 0.7)).toBe(false);
  });

  it("高于阈值 → true", () => {
    expect(shouldCompress(701, 1000, 0.7)).toBe(true);
    expect(shouldCompress(2000, 1000, 0.7)).toBe(true);
  });

  it("预算 0 或负 → false", () => {
    expect(shouldCompress(1000, 0)).toBe(false);
    expect(shouldCompress(1000, -1)).toBe(false);
  });
});

describe("estimateMessagesTokens", () => {
  it("累加所有消息 parts 文本", () => {
    const tokens = estimateMessagesTokens([uiMsg("user", "abcd"), uiMsg("assistant", "efgh")]);
    expect(tokens).toBe(2); // 8 chars / 4
  });

  // S1 修复（03-P2-2）：tool-call/tool-result part 按内容估算 + 固定开销，不再 JSON.stringify 整个 part
  it("tool-call part 按内容估算（非 JSON.stringify 整 part）", () => {
    const msg = {
      id: "m",
      role: "assistant",
      parts: [
        { type: "tool-call", toolCallId: "tc1", toolName: "runCommand", input: { command: "ls" } },
      ],
      createdAt: new Date(),
    } as unknown as ChatMessage;
    const tokens = estimateMessagesTokens([msg]);
    // 内容 "runCommand {...}" + 固定开销 8；远小于 JSON.stringify(整 part) 的 ~22+
    expect(tokens).toBeLessThan(20);
    expect(tokens).toBeGreaterThanOrEqual(8);
  });

  it("非 text/tool part（元数据）不计入", () => {
    const msg = {
      id: "m",
      role: "assistant",
      parts: [{ type: "data-attachment", data: { x: 1 } }],
      createdAt: new Date(),
    } as unknown as ChatMessage;
    expect(estimateMessagesTokens([msg])).toBe(0);
  });
});

// S1 修复（03-P1-3）：真 tokenizer（gpt-tokenizer o200k_base）计数
describe("countTokens（真 tokenizer）", () => {
  it("空串 → 0", async () => {
    expect(await countTokens("")).toBe(0);
  });

  it("中英混排给出合理 token 数（非 char/4）", async () => {
    const text = "实现一个登录页面 implement a login page";
    const n = await countTokens(text);
    expect(n).toBeGreaterThan(0);
    // 真实 BPE 计数应介于 char/4 与 char 之间
    expect(n).toBeLessThan(text.length);
  });

  it("缓存命中返回同值", async () => {
    const a = await countTokens("hello world cache test");
    const b = await countTokens("hello world cache test");
    expect(a).toBe(b);
  });
});

describe("countMessagesTokens（真 tokenizer 异步）", () => {
  it("累加 text + tool part", async () => {
    const msgs = [
      uiMsg("user", "hello world"),
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "tool-call", toolCallId: "tc1", toolName: "ls", input: { path: "." } }],
        createdAt: new Date(),
      } as unknown as ChatMessage,
    ];
    const n = await countMessagesTokens(msgs);
    expect(n).toBeGreaterThan(0);
  });
});

// S1 修复（03-P2-5）：上下文窗口可视化状态
describe("computeContextWindowStatus", () => {
  it("未配 contextWindow → loadLevel=unknown, configured=false", async () => {
    const s = await computeContextWindowStatus([uiMsg("user", "hi")], "unconfigured-model");
    expect(s.configured).toBe(false);
    expect(s.loadLevel).toBe("unknown");
    expect(s.used).toBeGreaterThan(0);
  });

  it("配了 contextWindow → loadLevel 按阈值分级", async () => {
    const orig = process.env.SNOW_CONTEXT_WINDOWS;
    process.env.SNOW_CONTEXT_WINDOWS = JSON.stringify({ "win-model": 1000 });
    try {
      // 短消息 used 远小于 1000 → normal
      const normal = await computeContextWindowStatus([uiMsg("user", "hi")], "win-model");
      expect(normal.configured).toBe(true);
      expect(normal.loadLevel).toBe("normal");
    } finally {
      process.env.SNOW_CONTEXT_WINDOWS = orig;
    }
  });
});
