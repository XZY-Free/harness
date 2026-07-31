import type { DBMessage } from "@/lib/db/schema";
import { convertToUIMessages, escapeLikeWildcards, generateUUID } from "@/lib/utils";
import { describe, expect, it } from "vitest";

describe("generateUUID", () => {
  it("应生成合法 v4 UUID", () => {
    const id = generateUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("两次调用不重复", () => {
    expect(generateUUID()).not.toBe(generateUUID());
  });
});

describe("convertToUIMessages", () => {
  const base = (parts: unknown[]): DBMessage =>
    ({
      id: "m1",
      threadId: "t1",
      role: "assistant",
      type: null,
      parts,
      createdAt: new Date("2026-06-24T05:00:00Z"),
      runId: null,
    }) as unknown as DBMessage;

  it("过滤 step-start 等内部 part 类型", () => {
    const out = convertToUIMessages([base([{ type: "step-start" }, { type: "text", text: "hi" }])]);
    const first = out[0];
    if (!first) throw new Error("expected message");
    expect(first.parts).toHaveLength(1);
    expect(first.parts[0]?.type).toBe("text");
  });

  it("给中断的孤儿 tool call 补错误 output，避免 SDK 抛 Tool result is missing", () => {
    const out = convertToUIMessages([
      base([
        {
          type: "tool-runCommand",
          toolCallId: "call_x",
          input: { cmd: "ls" },
          state: "input-available",
        },
      ]),
    ]);
    const first = out[0];
    if (!first) throw new Error("expected message");
    const part = first.parts[0] as unknown as {
      type: string;
      toolCallId: string;
      state: string;
      output: { error: string };
      isError: boolean;
    };
    expect(part.state).toBe("output-available");
    expect(part.isError).toBe(true);
    expect(part.output.error).toBe("执行已中断");
  });

  it("output-available 的 tool call 原样保留，不重复补 output", () => {
    const out = convertToUIMessages([
      base([
        {
          type: "tool-readFile",
          toolCallId: "call_y",
          input: { path: "a" },
          state: "output-available",
          output: { ok: true, content: "x" },
        },
      ]),
    ]);
    const first = out[0];
    if (!first) throw new Error("expected message");
    const part = first.parts[0] as unknown as { state: string; output: { content: string } };
    expect(part.state).toBe("output-available");
    expect(part.output.content).toBe("x");
  });
});

describe("escapeLikeWildcards (P2-2)", () => {
  it("转义 % _ \\", () => {
    expect(escapeLikeWildcards("100%_done")).toBe("100\\%\\_done");
    expect(escapeLikeWildcards("a\\b")).toBe("a\\\\b");
  });
  it("普通文本不变", () => {
    expect(escapeLikeWildcards("hello")).toBe("hello");
  });
});
