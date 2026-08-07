import { contextConfig } from "@/lib/config";
import type { ChatMessage } from "@/lib/types";

/**
 * a Stage B：预算估算与阈值判定。
 *
 * 关键不变式：`resolveTokenBudget` 在无 per-model contextWindow 配置时返回 `Infinity`，
 * `shouldCompress` 对 `Infinity` 预算恒为 false → **永不压缩 → 零回归**。
 * 即使没配 `SNOW_CONTEXT_WINDOWS`，也不破坏现有 chat 行为。
 *
 * S1 修复（03-升级真 tokenizer）：原 CJK 友好的 char 估算（CJK=1, ASCII=char/4）只是
 * 过渡方案，对中英混排/代码仍偏差。改用 `gpt-tokenizer`（o200k_base，GPT-4o 编码，纯 JS BPE）
 * 做真实 token 计数；tokenizer 不可用或异常时回退到 CJK 估算（fail-soft，不阻断）。
 * o200k_base 对 GLM/Qwen/Kimi 等中文模型略有偏差但远优于 char/4。
 */

/** CJK 字符范围：中日韩统一表意文字 + 扩展 A + 全角标点/符号。tokenizer 不可用时的回退估算用。 */
const CJK_RANGES: Array<[number, number]> = [
 [0x3000, 0x303f], // CJK 标点和符号
 [0x3040, 0x309f], // 平假名
 [0x30a0, 0x30ff], // 片假名
 [0x3400, 0x4dbf], // CJK 扩展 A
 [0x4e00, 0x9fff], // CJK 统一表意文字（基本区）
 [0xf900, 0xfaff], // CJK 兼容表意文字
 [0xff00, 0xffef], // 全角形式
];

function isCjk(code: number): boolean {
 for (const [lo, hi] of CJK_RANGES) {
 if (code >= lo && code <= hi) return true;
 }
 return false;
}

/** CJK 友好的回退估算（tokenizer 不可用时）：CJK=1 token/字符，ASCII=char/4。 */
function estimateTokensFallback(text: string): number {
 if (text.length === 0) return 0;
 let cjkCount = 0;
 let otherCount = 0;
 for (const ch of text) {
 if (isCjk(ch.codePointAt(0) ?? 0)) cjkCount++;
 else otherCount++;
 }
 return Math.ceil(cjkCount + otherCount / 4);
}

// ─── 真 tokenizer（懒加载 + 缓存） ───────────────────────────
let encodeFn: ((text: string) => number[]) | null | undefined;
/** 文本 → token 数缓存（上限 512 条，超出清空避免无界增长）。 */
const tokenCache = new Map<string, number>();
const TOKEN_CACHE_MAX = 512;

async function loadTokenizer(): Promise<((text: string) => number[]) | null> {
 if (encodeFn !== undefined) return encodeFn ? (t) => encodeFn?.(t) ?? [] : null;
 try {
 const mod = await import("gpt-tokenizer");
 encodeFn = (text: string) => mod.encode(text);
 return (t: string) => encodeFn?.(t) ?? [];
 } catch {
 // gpt-tokenizer 不可用 → 返回 null 供调用方走 CJK 估算回退
 encodeFn = null;
 return null;
 }
}

/**
 * 预热 tokenizer。
 *
 * 装配路径（buildContextPackage）入口调一次，加载 gpt-tokenizer 后，后续 sync `estimateTokens`/
 * `estimateMessagesTokens` 自动用真 BPE 计数（见 estimateTokens 的 `if (encodeFn)` 分支）。
 * 避免把核心路径每个 estimateTokens 调用都改成 async。失败静默回退到 CJK 估算（fail-soft）。
 */
export async function warmupTokenizer(): Promise<void> {
 await loadTokenizer();
}

/**
 * 真 token 计数（异步，经 gpt-tokenizer o200k_base）。失败回退 CJK 估算。
 * 带 token 缓存。供异步路径（package-builder 装配前估算）使用。
 */
export async function countTokens(text: string): Promise<number> {
 if (text.length === 0) return 0;
 const cached = tokenCache.get(text);
 if (cached !== undefined) return cached;
 const enc = await loadTokenizer();
 let n: number;
 if (enc === null) {
 // tokenizer 不可用，走 CJK 估算回退
 n = estimateTokensFallback(text);
 } else {
 try {
 const tokens = enc(text);
 n = tokens.length;
 } catch {
 n = estimateTokensFallback(text);
 }
 }
 if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
 tokenCache.set(text, n);
 return n;
}

/**
 * 同步 token 估算（CJK 友好回退）。
 *
 * 保留同步入口供不宜 await 的路径（如 shouldCompress 判定）。异步路径优先用 `countTokens`。
 * 若已加载过 tokenizer，用之；否则用 CJK 回退（不阻塞）。
 */
export function estimateTokens(text: string): number {
 if (text.length === 0) return 0;
 if (encodeFn) {
 try {
 return encodeFn(text).length;
 } catch {
 // fallthrough to fallback
 }
 }
 return estimateTokensFallback(text);
}

/**
 * 解析 model 的 token 预算。
 * 查 `contextConfig.contextWindowByModel`；未配置或非法 → `Infinity`（永不压缩）。
 */
export function resolveTokenBudget(model: string): number {
 const windows = contextConfig.contextWindowByModel;
 const win = windows[model];
 return typeof win === "number" && Number.isFinite(win) && win > 0
 ? win
 : Number.POSITIVE_INFINITY;
}

/**
 * 判定是否应触发压缩：`estimatedTokens > budget * threshold`。
 * `budget` 为 `Infinity`（无配置）时恒返回 false。
 */
export function shouldCompress(
 estimatedTokens: number,
 budget: number,
 threshold: number = contextConfig.budgetThreshold,
): boolean {
 if (!Number.isFinite(budget) || budget <= 0) return false;
 return estimatedTokens > budget * threshold;
}

/**
 * 估算一条消息内单个 part 的 token 数。
 *
 * 原对非文本 part 用 `JSON.stringify(whole part)` 高估（含 type/toolCallId/
 * state 等元数据）。改为按 part 语义提取有效内容：
 * - text part → 文本本身
 * - tool-call part → toolName + JSON(input)（input 是模型产出的真实负载）
 * - tool-result part → JSON(output)（output 是工具返回的真实负载）
 * - 其他 → 空串（元数据不计入，避免高估）
 * 每条 tool part 额外 +8 token 固定开销（近似 AI SDK 的 part 框架开销）。
 */
function estimatePartTokens(part: unknown): number {
 if (!part || typeof part !== "object") return 0;
 const p = part as {
 type?: string;
 text?: unknown;
 toolName?: unknown;
 input?: unknown;
 output?: unknown;
 };
 if (p.type === "text" && typeof p.text === "string") {
 return estimateTokens(p.text);
 }
 if (p.type === "tool-call") {
 const toolName = typeof p.toolName === "string" ? p.toolName : "";
 const inputStr = p.input !== undefined ? JSON.stringify(p.input) : "";
 return estimateTokens(`${toolName} ${inputStr}`) + 8;
 }
 if (p.type === "tool-result") {
 const outputStr = p.output !== undefined ? JSON.stringify(p.output) : "";
 return estimateTokens(outputStr) + 8;
 }
 // 其他 part（data-* / reasoning 等）元数据不计入，避免高估
 return 0;
}

/** 估算一组 UIMessage 的总 token（按 parts 有效内容求和）。 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
 return messages.reduce(
 (sum, m) => sum + (m.parts ?? []).reduce((s, p) => s + estimatePartTokens(p), 0),
 0,
 );
}

/** 异步版本：用真 tokenizer 计数（装配前精确估算用）。 */
export async function countMessagesTokens(messages: ChatMessage[]): Promise<number> {
 let total = 0;
 for (const m of messages) {
 for (const p of m.parts ?? []) {
 if (!p || typeof p !== "object") continue;
 const part = p as {
 type?: string;
 text?: unknown;
 toolName?: unknown;
 input?: unknown;
 output?: unknown;
 };
 if (part.type === "text" && typeof part.text === "string") {
 total += await countTokens(part.text);
 } else if (part.type === "tool-call") {
 const toolName = typeof part.toolName === "string" ? part.toolName : "";
 const inputStr = part.input !== undefined ? JSON.stringify(part.input) : "";
 total += (await countTokens(`${toolName} ${inputStr}`)) + 8;
 } else if (part.type === "tool-result") {
 const outputStr = part.output !== undefined ? JSON.stringify(part.output) : "";
 total += (await countTokens(outputStr)) + 8;
 }
 }
 }
 return total;
}

/**
 * 上下文窗口可视化状态（供 Studio 实时展示占用/阈值）。
 *
 * 纯函数：接收消息 + model，返回 {budget, used, thresholds, loadLevel}。
 * budget=Infinity（未配 contextWindow）时 loadLevel=unknown，used 仍返回估算值。
 * loadLevel：normal(<soft) / soft(soft..budget) / hard(>budget) / critical(>critical)。
 */
export type ContextWindowStatus = {
 budget: number;
 used: number;
 softThreshold: number;
 budgetThreshold: number;
 criticalThreshold: number;
 loadLevel: "normal" | "soft" | "hard" | "critical" | "unknown";
 configured: boolean;
};

export async function computeContextWindowStatus(
 messages: ChatMessage[],
 model: string,
): Promise<ContextWindowStatus> {
 await warmupTokenizer();
 const budget = resolveTokenBudget(model);
 const used = await countMessagesTokens(messages);
 const soft = contextConfig.softThreshold;
 const hard = contextConfig.budgetThreshold;
 const crit = contextConfig.criticalThreshold;
 const configured = Number.isFinite(budget);
 let loadLevel: ContextWindowStatus["loadLevel"] = "unknown";
 if (configured) {
 const ratio = used / budget;
 loadLevel =
 ratio >= crit ? "critical" : ratio >= hard ? "hard" : ratio >= soft ? "soft" : "normal";
 }
 return {
 budget,
 used,
 softThreshold: soft,
 budgetThreshold: hard,
 criticalThreshold: crit,
 loadLevel,
 configured,
 };
}
