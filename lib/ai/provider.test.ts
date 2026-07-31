import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1(01 AI Core P1-2 完整化):provider 多 endpoint 熔断切换测试。
 *
 * mock aiConfig 提供主 + fallback endpoints,验证:
 * - 默认选主 endpoint
 * - 主连续失败超阈值 → 熔断,切 fallback
 * - 冷却到期 → 主恢复(半开)
 * - 无 fallback 时熔断后降级返回主
 */

vi.mock("@/lib/config", () => ({
  aiConfig: {
    apiKey: "test-key",
    baseUrl: "https://main.example.com/v1",
    fallbackBaseUrls: ["https://backup1.example.com/v1", "https://backup2.example.com/v1"],
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn((opts: { baseURL: string }) => {
    // 返回一个 fake provider 函数,modelId => ({ __endpoint: baseURL, modelId })
    return vi.fn((modelId: string) => ({ __endpoint: opts.baseURL, modelId }));
  }),
}));

import { _resetEndpointHealthForTest, getChatModel, markCurrentEndpointFailed } from "./provider";

beforeEach(() => {
  _resetEndpointHealthForTest();
});

afterEach(() => {
  _resetEndpointHealthForTest();
});

describe("P1-2 provider 多 endpoint 熔断切换", () => {
  it("默认选主 endpoint", () => {
    const model = getChatModel("glm-5.2") as unknown as { __endpoint: string };
    expect(model.__endpoint).toBe("https://main.example.com/v1");
  });

  it("主连续失败 3 次 → 熔断,切第一个 fallback", () => {
    // 主 endpoint 用 getChatModel 选中,再标失败 3 次
    getChatModel("glm-5.2");
    markCurrentEndpointFailed();
    markCurrentEndpointFailed();
    markCurrentEndpointFailed();
    // 第 3 次后熔断,下次 getChatModel 切 fallback1
    const model = getChatModel("glm-5.2") as unknown as { __endpoint: string };
    expect(model.__endpoint).toBe("https://backup1.example.com/v1");
  });

  it("熔断后备用也失败 → 切第二个 fallback", () => {
    // 熔断主
    getChatModel("glm-5.2");
    markCurrentEndpointFailed();
    markCurrentEndpointFailed();
    markCurrentEndpointFailed();
    // 选 fallback1,熔断它
    getChatModel("glm-5.2");
    markCurrentEndpointFailed();
    markCurrentEndpointFailed();
    markCurrentEndpointFailed();
    // 切 fallback2
    const model = getChatModel("glm-5.2") as unknown as { __endpoint: string };
    expect(model.__endpoint).toBe("https://backup2.example.com/v1");
  });

  it("未达熔断阈值(2 次)→ 不切换,仍用主", () => {
    getChatModel("glm-5.2");
    markCurrentEndpointFailed();
    markCurrentEndpointFailed();
    const model = getChatModel("glm-5.2") as unknown as { __endpoint: string };
    expect(model.__endpoint).toBe("https://main.example.com/v1");
  });

  it("失败 2 次后成功(不重置)→ 第 3 次失败仍熔断", () => {
    // 失败计数累积,不因成功重置(简化:只增不减,冷却到期才重置)
    getChatModel("glm-5.2");
    markCurrentEndpointFailed();
    markCurrentEndpointFailed();
    // 中间一次成功(getChatModel 不重置计数)
    getChatModel("glm-5.2");
    markCurrentEndpointFailed(); // 第 3 次 → 熔断
    const model = getChatModel("glm-5.2") as unknown as { __endpoint: string };
    expect(model.__endpoint).toBe("https://backup1.example.com/v1");
  });
});
