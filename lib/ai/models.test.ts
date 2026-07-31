import { dedupeModels, isChatModel } from "@/lib/ai/models";
import { afterEach, describe, expect, it } from "vitest";

describe("isChatModel", () => {
  it.each([
    "kimi-k2.6",
    "kimi-k2.7-code",
    "qwen-max",
    "qwen-plus",
    "qwen-turbo",
    "qwen-long",
    "qwen-coder-plus",
    "qwen3-coder-plus",
    "qwen3-235b-a22b",
    "qwen3.7-max",
    "qwen3.5-plus",
    "deepseek-v3",
    "deepseek-v4-pro",
    "deepseek-r1",
    "glm-5.2",
    "MiniMax-M2.5",
  ])("保留对话/代码模型 %s", (id) => {
    expect(isChatModel(id)).toBe(true);
  });

  it.each([
    "qwen3-tts-flash",
    "wan2.7-image",
    "qwen3-asr-flash-2026-02-10",
    "qwen-vl-max",
    "qwen-math-plus",
    "qwen3-omni-flash",
    "qwen-mt-plus",
    "qvq-max",
    "z-image-turbo",
    "qwen3-livetranslate-flash",
    "qwen-vl-ocr",
    "codeqwen1.5-7b-chat",
  ])("排除非对话模型 %s", (id) => {
    expect(isChatModel(id)).toBe(false);
  });
});

describe("dedupeModels", () => {
  it("vendor/model 与裸名并存时保留裸名", () => {
    expect(dedupeModels(["kimi-k2.6", "kimi/kimi-k2.6", "glm-5.2"])).toEqual([
      "kimi-k2.6",
      "glm-5.2",
    ]);
  });
  it("仅 vendor/model 时保留它", () => {
    expect(dedupeModels(["MiniMax/MiniMax-M2.7"])).toEqual(["MiniMax/MiniMax-M2.7"]);
  });
});

// S1 修复（01-P1-8）：显式 allowlist 模式
describe("isChatModel allowlist 模式", () => {
  const orig = { ...process.env };
  afterEach(() => {
    for (const k of ["CHAT_MODEL_ALLOWLIST", "CHAT_MODEL_DENY_SUBSTRINGS", "SNOW_CHAT_MODEL"]) {
      delete process.env[k];
    }
    Object.assign(process.env, orig);
  });

  it("设 CHAT_MODEL_ALLOWLIST → 只放行白名单 + chatModel", () => {
    process.env.CHAT_MODEL_ALLOWLIST = "glm-5.2,qwen-max";
    process.env.SNOW_CHAT_MODEL = "glm-5.2";
    expect(isChatModel("glm-5.2")).toBe(true);
    expect(isChatModel("qwen-max")).toBe(true);
    // 白名单外的不放行（即使原本是"对话模型"）
    expect(isChatModel("kimi-k2.6")).toBe(false);
    expect(isChatModel("image-gen")).toBe(false);
  });

  it("未设 allowlist → 用默认子串黑名单（image 等仍排除）", () => {
    expect(isChatModel("some-image-model")).toBe(false);
    expect(isChatModel("glm-5.2")).toBe(true);
  });

  it("设 CHAT_MODEL_DENY_SUBSTRINGS → 覆盖默认黑名单", () => {
    process.env.CHAT_MODEL_DENY_SUBSTRINGS = "custom-bad";
    // 覆盖后默认 image 不再被排除（仅 custom-bad 排除）
    expect(isChatModel("some-image-model")).toBe(true);
    expect(isChatModel("custom-bad-thing")).toBe(false);
  });
});
