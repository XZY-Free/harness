import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aiConfig, backgroundTaskConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { z } from "zod";

/**
 * Stage C：visualVerdict——对截图做结构化视觉评审（plan §7 / §1 决策）。
 *
 * **可选调 LLM**（agent 自检用）；gate **绝不依赖**本工具。无 LLM 配置或调用失败时
 * 退化为确定性基础判断（截图尺寸 / 白屏启发式），layout/misalignment 标 unknown。
 *
 * 输出 `{ layout, blank, misalignment, summary }`：
 * - layout: 'good' | 'broken' | 'unknown'
 * - blank: boolean（截图疑似白屏）
 * - misalignment: 'none' | 'detected' | 'unknown'
 * - summary: 人类可读摘要
 */

export type VisualLayout = "good" | "broken" | "unknown";
export type VisualMisalignment = "none" | "detected" | "unknown";

export interface VisualVerdict {
 layout: VisualLayout;
 blank: boolean;
 misalignment: VisualMisalignment;
 summary: string;
 /** 是否实际调用了 LLM（false=确定性退化）。 */
 usedLlm: boolean;
}

export type VisualJudge = (imageBase64: string, prompt: string) => Promise<Partial<VisualVerdict>>;

function errMsg(error: unknown): string {
 return error instanceof Error ? error.message : String(error);
}

/** 确定性退化判断：仅依据截图 buffer 大小推断白屏。 */
function deterministicVerdict(buf: Buffer): VisualVerdict {
 // 全页 PNG < 2KB 通常为空白页（真实页面远大于此）。启发式，非精确。
 const blank = buf.length < 2048;
 return {
 layout: "unknown",
 blank,
 misalignment: "unknown",
 summary: blank
 ? "确定性判断：截图体积极小，疑似白屏（无 LLM 配置，未做布局评审）"
 : "确定性判断：截图体积正常（无 LLM 配置，layout/misalignment 未评审）",
 usedLlm: false,
 };
}

/**
 * 默认 LLM judge：用现有 OpenAI 兼容 provider + 可选 QA_VISUAL_MODEL 对截图做视觉评审。
 *
 * 原实现用 generateText + 自由文本 + 关键词子串解析（"fractured" 解析为
 * unknown、"正常但有小问题" 解析为 good），脆弱。改用 `generateObject` + zod schema 强制结构化输出,
 * 模型直接产出 {layout, blank, misalignment, summary}，消除文本解析歧义。
 * 失败（无 apiKey / 模型不支持视觉/generateObject / 网络错）→ 抛错，由调用方退化为确定性判断。
 */
const VISUAL_VERDICT_SCHEMA = z.object({
 layout: z.enum(["good", "broken", "unknown"]),
 blank: z.boolean(),
 misalignment: z.enum(["none", "detected", "unknown"]),
 summary: z.string().max(500),
});

async function defaultJudge(imageBase64: string, prompt: string): Promise<Partial<VisualVerdict>> {
 if (!aiConfig.apiKey) {
 throw new Error("LLM_API_KEY 未配置");
 }
 const { getChatModel } = await import("@/lib/ai/provider");
 const { generateObject } = await import("ai");
 const modelId = process.env.QA_VISUAL_MODEL ?? aiConfig.chatModel;
 const model = getChatModel(modelId);
 const { object } = await generateObject({
 model,
 schema: VISUAL_VERDICT_SCHEMA,
 messages: [
 {
 role: "user",
 content: [
 { type: "image", image: imageBase64 },
 { type: "text", text: prompt },
 ],
 },
 ],
 });
 return {
 layout: object.layout,
 blank: object.blank,
 misalignment: object.misalignment,
 summary: object.summary,
 };
}

export async function visualVerdict(opts: {
 threadId: string;
 screenshotPath: string;
 prompt?: string;
 /** 注入 judge（测试用）；缺省用 defaultJudge（现有 provider）。 */
 judge?: VisualJudge;
}): Promise<VisualVerdict & { ok: boolean; error?: string }> {
 const prompt =
 opts.prompt ??
 "评审这张网页截图：是否有明显布局破坏/白屏/元素错位？输出 layout(good/broken)、blank、misalignment(none/detected) 与简短 summary。";

 // 解析截图绝对路径（相对 hostLogDir，边界校验防越界）
 const base = resolve(backgroundTaskConfig.hostLogDir);
 const abs = resolve(base, opts.screenshotPath);
 if (abs !== base && !abs.startsWith(`${base}/`)) {
 return { ...deterministicVerdict(Buffer.alloc(0)), ok: false, error: "非法截图路径" };
 }
 let buf: Buffer;
 try {
 buf = await readFile(abs);
 } catch (error) {
 return {
 ...deterministicVerdict(Buffer.alloc(0)),
 ok: false,
 error: `截图读取失败：${errMsg(error)}`,
 };
 }

 const judge = opts.judge ?? defaultJudge;
 try {
 const imageBase64 = buf.toString("base64");
 const llmResult = await judge(imageBase64, prompt);
 const det = deterministicVerdict(buf);
 return {
 layout: llmResult.layout ?? det.layout,
 blank: llmResult.blank ?? det.blank,
 misalignment: llmResult.misalignment ?? det.misalignment,
 summary: llmResult.summary ?? det.summary,
 usedLlm: true,
 ok: true,
 };
 } catch (error) {
 logger.warn("[qa] visualVerdict LLM 不可用，退化为确定性判断", {
 error: error instanceof Error ? error.message : String(error),
 });
 return { ...deterministicVerdict(buf), ok: true };
 }
}
