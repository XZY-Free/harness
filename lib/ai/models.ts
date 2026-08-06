import { aiConfig, modelFilterConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

/**
 * 模型列表：从 OpenAI 兼容端点 /models 动态拉取 + 过滤 + 缓存。
 *
 * 百炼 /models 无能力字段（对象仅 id/object/created/owned_by），无法靠元数据
 * 区分对话/图像/语音模型。原纯子串黑名单脆弱（新模型命中漏判 /
 * 误伤），改为两段可配置过滤：
 * 1. `CHAT_MODEL_ALLOWLIST`（逗号分隔）：显式白名单，设置后**只**放行白名单内模型
 * （+ 当前 chatModel），不再走子串猜测——最精确、运维完全可控。
 * 2. 未设白名单时退回 `CHAT_MODEL_DENY_SUBSTRINGS`（逗号分隔，默认含 image/tts/asr/
 * embedding/vl/语音/翻译/数学等已知非对话子串）黑名单过滤，保持零配置可用。
 *
 * 两段都从 env 读，新增模型类别无需改代码。
 */

/** 默认排除子串（非对话/代码模型）。可通过 CHAT_MODEL_DENY_SUBSTRINGS 覆盖/扩展。 */
const DEFAULT_EXCLUDE_SUBSTRINGS = [
 "image",
 "tts",
 "asr",
 "ocr",
 "speech",
 "embedding",
 "realtime",
 "omni",
 "-vl",
 "vl-",
 "-vc",
 "-vd",
 "livetranslate",
 "s2s",
 "-mt",
 "mt-",
 "math",
 "gui",
 "research",
 "deep-search",
 "wan",
 "z-image",
 "qvq",
 "codeqwen",
 "tongyi-xiaomi",
 "sre-gpu",
 "qwentype",
] as const;

/**
 * 是否为对话/代码模型。
 *
 * 优先用显式 allowlist（设了就只放行白名单 + chatModel）；未设则用子串黑名单。
 */
export function isChatModel(id: string): boolean {
 const low = id.toLowerCase();
 // 显式白名单：设了就只放行白名单内（+ 当前 chatModel），不走子串猜测
 if (modelFilterConfig.allowlist.length > 0) {
 return (
 modelFilterConfig.allowlist.some((m) => m.toLowerCase() === low) ||
 low === aiConfig.chatModel.toLowerCase()
 );
 }
 // 未设白名单 → 子串黑名单（env 覆盖；未设 env 用默认列表）
 const deny =
 modelFilterConfig.denySubstrings.length > 0
 ? modelFilterConfig.denySubstrings
 : DEFAULT_EXCLUDE_SUBSTRINGS.map((s) => s.toLowerCase());
 return !deny.some((s) => low.includes(s));
}

/** `vendor/model` 与裸 `model` 并存时保留裸名（如 kimi/kimi-k2.6 → kimi-k2.6）。 */
export function dedupeModels(ids: string[]): string[] {
 const bare = new Set(ids.filter((i) => !i.includes("/")));
 return ids.filter((i) => {
 if (!i.includes("/")) {
 return true;
 }
 const tail = i.split("/").pop() ?? i;
 return !bare.has(tail);
 });
}

export type ModelInfo = { id: string };

let cache: { at: number; models: ModelInfo[] } | null = null;
const TTL_MS = 10 * 60 * 1000;

/** 拉 /models → 过滤 → 去重 → 排序；失败降级到默认模型。带 10 分钟内存缓存。 */
export async function fetchAvailableModels(): Promise<ModelInfo[]> {
 if (cache && Date.now() - cache.at < TTL_MS) {
 return cache.models;
 }
 try {
 const res = await fetch(`${aiConfig.baseUrl.replace(/\/$/, "")}/models`, {
 headers: { Authorization: `Bearer ${aiConfig.apiKey}` },
 });
 if (!res.ok) {
 throw new Error(`/models HTTP ${res.status}`);
 }
 const body = (await res.json()) as { data?: Array<{ id: string }> };
 const ids = (body.data ?? []).map((m) => m.id).filter(isChatModel);
 const models = dedupeModels(ids)
 .sort()
 .map((id) => ({ id }));
 cache = { at: Date.now(), models };
 return models;
 } catch (error) {
 logger.warn("fetchAvailableModels 失败，降级到默认模型", {
 error: (error as Error).message,
 });
 return [{ id: aiConfig.chatModel }];
 }
}

/** 模型 id 是否在当前可用列表中。 */
export async function isValidModelId(id: string): Promise<boolean> {
 const models = await fetchAvailableModels();
 return models.some((m) => m.id === id);
}
