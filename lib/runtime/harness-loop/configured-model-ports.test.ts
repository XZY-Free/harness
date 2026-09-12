import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(async (_options: { prompt: string }) => ({
    object: {
      actionId: "action-1",
      stepNo: 1,
      purposeCode: "answer_user",
      shortPurpose: "回答",
      actionType: "respond",
      payload: {},
    },
  })),
  streamText: vi.fn(),
}));

vi.mock("@/lib/ai/provider", () => ({ getChatModel: vi.fn(() => ({ modelId: "test" })) }));
vi.mock("ai", () => ({
  generateObject: mocks.generateObject,
  streamText: mocks.streamText,
}));

import { configuredDecisionPort, configuredFinalResponsePort } from "./configured-model-ports";

async function* parts(list: Array<{ type: string; text?: string; finishReason?: string }>) {
  for (const part of list) yield part;
}

describe("configured Harness model ports", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "LLM_API_KEY");
    mocks.generateObject.mockClear();
    mocks.streamText.mockClear();
  });

  it("结构化行动提示显式包含小写 json，兼容严格 OpenAI 端点", async () => {
    process.env.LLM_API_KEY = "test-key";
    const port = configuredDecisionPort("test-model");

    await port.decideNextAction({ objective: "你好" } as never);

    expect(mocks.generateObject).toHaveBeenCalledOnce();
    const prompt = mocks.generateObject.mock.calls[0]?.[0].prompt;
    expect(prompt).toMatch(/\bjson\b/);
    expect(prompt).toContain('"actionId"');
    expect(prompt).toContain('"actionType"');
  });

  it("决策与正文共享系统当前时间，基础聊天无需工具观测", async () => {
    process.env.LLM_API_KEY = "test-key";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    try {
      await configuredDecisionPort("test-model").decideNextAction({
        objective: "今天日期是多少",
      } as never);
      expect(mocks.generateObject.mock.calls[0]?.[0].prompt).toContain("2026-09-12T12:00:00.000Z");
      mocks.streamText.mockReturnValueOnce({
        fullStream: parts([
          { type: "text-delta", text: "日期回复" },
          { type: "finish", finishReason: "stop" },
        ]),
      });
      await configuredFinalResponsePort("test-model").generateFinalResponse(
        { objective: "今天日期是多少" } as never,
        vi.fn(),
        undefined,
      );
      expect(mocks.streamText.mock.calls[0]?.[0].prompt).toContain("2026-09-12T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("正文流截断时静默重试一次并重试不重复发射 delta", async () => {
    process.env.LLM_API_KEY = "test-key";
    mocks.streamText
      .mockReturnValueOnce({
        fullStream: parts([
          { type: "text-delta", text: "残缺" },
          { type: "finish", finishReason: "length" },
        ]),
      })
      .mockReturnValueOnce({
        fullStream: parts([
          { type: "text-delta", text: "完整回答" },
          { type: "finish", finishReason: "stop" },
        ]),
      });
    const emit = vi.fn(async (_delta: string) => undefined);
    const port = configuredFinalResponsePort("test-model");

    const text = await port.generateFinalResponse({ objective: "你好" } as never, emit, undefined);

    expect(text).toBe("完整回答");
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("连续截断时抛错按失败关闭，不落残缺正文", async () => {
    process.env.LLM_API_KEY = "test-key";
    mocks.streamText.mockImplementation(() => ({
      fullStream: parts([
        { type: "text-delta", text: "残缺" },
        { type: "finish", finishReason: "length" },
      ]),
    }));
    const port = configuredFinalResponsePort("test-model");

    await expect(
      port.generateFinalResponse({ objective: "你好" } as never, vi.fn(), undefined),
    ).rejects.toThrow("模型正文异常终结");
  });
});
