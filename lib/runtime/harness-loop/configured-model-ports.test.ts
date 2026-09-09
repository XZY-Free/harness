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
}));

vi.mock("@/lib/ai/provider", () => ({ getChatModel: vi.fn(() => ({ modelId: "test" })) }));
vi.mock("ai", () => ({
  generateObject: mocks.generateObject,
  streamText: vi.fn(),
}));

import { configuredDecisionPort } from "./configured-model-ports";

describe("configured Harness model ports", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "LLM_API_KEY");
    mocks.generateObject.mockClear();
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
});
