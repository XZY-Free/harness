import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.6 Stage C：visualVerdict 单测。
 * - 注入 judge 测 LLM 路径（不真实调模型）。
 * - 无 judge + LLM_API_KEY 空 → 确定性退化（白屏启发式）。
 * - P1-2：mock ai.generateObject + provider.getChatModel,测 defaultJudge 真实
 *   generateObject+VISUAL_VERDICT_SCHEMA 路径（原仅注入 mock judge,零覆盖）。
 */

// P1-2：mock ai 模块的 generateObject,拦截 defaultJudge 内的动态 import("ai")
const aiMock = vi.hoisted(() => ({
  generateObject: vi.fn(),
}));
// P1-2：mock provider 的 getChatModel,避免真实创建 OpenAI provider
const providerMock = vi.hoisted(() => ({
  getChatModel: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: aiMock.generateObject,
}));
vi.mock("@/lib/ai/provider", () => ({
  getChatModel: providerMock.getChatModel,
}));

const TEST_DIR = resolve(".test-visual-verdict");
const origLogDir = process.env.SNOW_BG_TASK_HOST_LOG_DIR;
const origKey = process.env.LLM_API_KEY;
const origModel = process.env.QA_VISUAL_MODEL;
const TID = "vv-thread";

beforeEach(async () => {
  process.env.SNOW_BG_TASK_HOST_LOG_DIR = TEST_DIR;
  process.env.LLM_API_KEY = "";
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.QA_VISUAL_MODEL;
  aiMock.generateObject.mockReset();
  providerMock.getChatModel.mockReset();
  providerMock.getChatModel.mockReturnValue("fake-model");
  await rm(TEST_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  process.env.SNOW_BG_TASK_HOST_LOG_DIR = origLogDir;
  process.env.LLM_API_KEY = origKey;
  if (origModel !== undefined) process.env.QA_VISUAL_MODEL = origModel;
  else {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.QA_VISUAL_MODEL;
  }
  await rm(TEST_DIR, { recursive: true, force: true });
});

import { visualVerdict } from "@/lib/qa/visual-verdict";

async function writeScreenshot(name: string, bytes: number): Promise<string> {
  const rel = `${TID}/qa/${name}`;
  const abs = resolve(TEST_DIR, rel);
  await mkdir(resolve(abs, ".."), { recursive: true });
  await writeFile(abs, Buffer.alloc(bytes, 0x88));
  return rel;
}

describe("visualVerdict", () => {
  it("注入 judge → 走 LLM 路径，合并判定，usedLlm=true", async () => {
    const rel = await writeScreenshot("big.png", 4096);
    const judge = vi.fn().mockResolvedValue({
      layout: "good",
      blank: false,
      misalignment: "none",
      summary: "布局正常",
    });
    const v = await visualVerdict({ threadId: TID, screenshotPath: rel, judge });
    expect(judge).toHaveBeenCalled();
    expect(v.usedLlm).toBe(true);
    expect(v.layout).toBe("good");
    expect(v.summary).toBe("布局正常");
    expect(v.ok).toBe(true);
  });

  it("无 judge + LLM_API_KEY 空 → 确定性退化，usedLlm=false", async () => {
    const rel = await writeScreenshot("big.png", 4096);
    const v = await visualVerdict({ threadId: TID, screenshotPath: rel });
    expect(v.usedLlm).toBe(false);
    expect(v.layout).toBe("unknown");
    expect(v.blank).toBe(false); // 4KB > 2KB 阈值
    expect(v.ok).toBe(true);
  });

  it("极小截图 → 确定性判定 blank=true", async () => {
    const rel = await writeScreenshot("tiny.png", 512);
    const v = await visualVerdict({ threadId: TID, screenshotPath: rel });
    expect(v.usedLlm).toBe(false);
    expect(v.blank).toBe(true);
    expect(v.summary).toContain("白屏");
  });

  it("judge 抛错 → 退化为确定性判断（不失败）", async () => {
    const rel = await writeScreenshot("big.png", 4096);
    const judge = vi.fn().mockRejectedValue(new Error("model unavailable"));
    const v = await visualVerdict({ threadId: TID, screenshotPath: rel, judge });
    expect(v.usedLlm).toBe(false);
    expect(v.ok).toBe(true);
  });

  it("截图不存在 → ok:false + error", async () => {
    const v = await visualVerdict({ threadId: TID, screenshotPath: `${TID}/qa/nope.png` });
    expect(v.ok).toBe(false);
    expect(v.error).toContain("读取失败");
  });

  it("路径越界 → ok:false", async () => {
    const v = await visualVerdict({ threadId: TID, screenshotPath: "../../etc/passwd" });
    expect(v.ok).toBe(false);
  });

  // ─── P1-2：defaultJudge 真实 generateObject 路径 ─────────────
  // 核实发现：原只注入 mock judge,defaultJudge 内 generateObject+VISUAL_VERDICT_SCHEMA
  // 零覆盖。这里不注入 judge,走 defaultJudge → mock 的 generateObject。

  it("P1-2 defaultJudge 调 generateObject + schema → 结构化判定,usedLlm=true", async () => {
    process.env.LLM_API_KEY = "fake-key";
    const rel = await writeScreenshot("llm.png", 4096);
    aiMock.generateObject.mockResolvedValue({
      object: {
        layout: "broken",
        blank: false,
        misalignment: "detected",
        summary: "移动端导航错位",
      },
    });
    const v = await visualVerdict({ threadId: TID, screenshotPath: rel });
    expect(aiMock.generateObject).toHaveBeenCalledTimes(1);
    // 验证 schema 被传入（VISUAL_VERDICT_SCHEMA 是 z.object,有 parse 方法）
    const firstCall = aiMock.generateObject.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error("generateObject was not called");
    const callArgs = firstCall[0] as {
      model: unknown;
      schema: { parse: (v: unknown) => unknown };
      messages: Array<{ role: string; content: unknown[] }>;
    };
    expect(callArgs.schema).toBeTruthy();
    expect(typeof callArgs.schema.parse).toBe("function");
    // schema 应能 parse 合法对象（验证是 VISUAL_VERDICT_SCHEMA 结构）
    expect(
      callArgs.schema.parse({ layout: "good", blank: false, misalignment: "none", summary: "ok" }),
    ).toEqual({ layout: "good", blank: false, misalignment: "none", summary: "ok" });
    // 消息含 image + text
    expect(callArgs.messages).toHaveLength(1);
    const firstMessage = callArgs.messages[0];
    expect(firstMessage).toBeDefined();
    if (!firstMessage) throw new Error("visual verdict message missing");
    const content = firstMessage.content;
    expect(content).toHaveLength(2);
    expect((content[0] as { type: string }).type).toBe("image");
    expect((content[1] as { type: string }).type).toBe("text");
    // 返回结构
    expect(v.usedLlm).toBe(true);
    expect(v.layout).toBe("broken");
    expect(v.misalignment).toBe("detected");
    expect(v.summary).toBe("移动端导航错位");
    expect(v.ok).toBe(true);
  });

  it("P1-2 defaultJudge 用 QA_VISUAL_MODEL 覆盖默认 chatModel", async () => {
    process.env.LLM_API_KEY = "fake-key";
    process.env.QA_VISUAL_MODEL = "gpt-4o-mini";
    const rel = await writeScreenshot("llm.png", 4096);
    aiMock.generateObject.mockResolvedValue({
      object: { layout: "good", blank: false, misalignment: "none", summary: "ok" },
    });
    await visualVerdict({ threadId: TID, screenshotPath: rel });
    expect(providerMock.getChatModel).toHaveBeenCalledWith("gpt-4o-mini");
  });

  it("P1-2 generateObject 返回不匹配 schema 的字段 → 抛错被 catch,退化为确定性(fail-closed)", async () => {
    process.env.LLM_API_KEY = "fake-key";
    const rel = await writeScreenshot("llm.png", 4096);
    // 模拟模型返回非法 layout 值（不在 enum 内）→ zod schema parse 应抛错
    // defaultJudge 不自己 parse,但 generateObject 内部用 schema 校验会抛
    aiMock.generateObject.mockRejectedValue(new Error("Invalid enum value 'weird'"));
    const v = await visualVerdict({ threadId: TID, screenshotPath: rel });
    // 抛错被 visualVerdict catch → 退化为确定性判断,不失败
    expect(aiMock.generateObject).toHaveBeenCalled();
    expect(v.usedLlm).toBe(false);
    expect(v.ok).toBe(true);
    // 4KB > 2KB 阈值 → blank=false
    expect(v.blank).toBe(false);
  });

  it("P1-2 无 LLM_API_KEY → defaultJudge 抛错,退化为确定性判断", async () => {
    // LLM_API_KEY 空（beforeEach 已设）
    const rel = await writeScreenshot("big.png", 4096);
    const v = await visualVerdict({ threadId: TID, screenshotPath: rel });
    expect(aiMock.generateObject).not.toHaveBeenCalled();
    expect(v.usedLlm).toBe(false);
    expect(v.ok).toBe(true);
  });
});
