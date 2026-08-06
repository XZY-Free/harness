import { aiConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * LLM 接入：OpenAI 兼容端点（百炼 DashScope compatible-mode）。
 *
 * 多 endpoint + 熔断切换。
 * 原 17 行单 provider,主 endpoint 宕机/限流时整个平台瘫痪。现支持配 fallback
 * endpoints(SNOW_LLM_FALLBACK_BASEURLS),主 endpoint 连续失败熔断后切备用。
 *
 * 熔断语义(进程级,避免请求内重试的流式复杂度):
 * - getChatModel 选当前健康 endpoint(主优先,fallback 次之)创建/复用 provider
 * - markCurrentEndpointFailed 失败计数,超阈值(3 次)标不健康 60s(冷却)
 * - 下次 getChatModel 跳过不健康 endpoint,选健康备用
 * - 冷却到期自动恢复(半开,下次失败再熔断)
 *
 * 单 endpoint 配置(无 fallback)时,熔断后无备用可选,getChatModel 仍返回主 endpoint
 * (maxRetries 已对 429/5xx 退避,熔断主要价值在多 endpoint 场景)。
 */

/** endpoint 健康状态。 */
type EndpointHealth = {
 baseUrl: string;
 failCount: number;
 disabledUntil: number; // 0=健康;>now=熔断中
};

const FAIL_THRESHOLD = 3;
const COOLDOWN_MS = 60_000;

/** endpoint 列表(主 + fallback),去重保序。 */
function allEndpoints(): string[] {
 const list = [aiConfig.baseUrl, ...aiConfig.fallbackBaseUrls];
 return [...new Set(list)]; // 去重(主与 fallback 相同则合并)
}

/** endpoint 健康 map(进程级,单实例语义)。 */
const health = new Map<string, EndpointHealth>();
/** 上次 getChatModel 选中的 endpoint(供 markCurrentEndpointFailed 定位)。 */
let lastSelectedEndpoint: string | null = null;

function getHealth(baseUrl: string): EndpointHealth {
 let h = health.get(baseUrl);
 if (!h) {
 h = { baseUrl, failCount: 0, disabledUntil: 0 };
 health.set(baseUrl, h);
 }
 return h;
}

/** provider 缓存(按 baseUrl,避免重复创建)。 */
const providers = new Map<string, ReturnType<typeof createOpenAICompatible>>();
function getProvider(baseUrl: string) {
 let p = providers.get(baseUrl);
 if (!p) {
 p = createOpenAICompatible({
 name: "snow-llm",
 baseURL: baseUrl,
 apiKey: aiConfig.apiKey,
 });
 providers.set(baseUrl, p);
 }
 return p;
}

/** 选当前健康 endpoint(主优先,跳过熔断中)。无健康备用时返回主(降级)。 */
function selectEndpoint(): string {
 const now = Date.now();
 const endpoints = allEndpoints();
 for (const url of endpoints) {
 const h = getHealth(url);
 if (h.disabledUntil <= now) {
 // 健康(或冷却到期,半开)
 if (h.disabledUntil > 0 && h.failCount >= FAIL_THRESHOLD) {
 // 冷却到期:重置为半开(failCount 保留 1,下次失败再熔断)
 h.disabledUntil = 0;
 h.failCount = 1;
 }
 return url;
 }
 }
 // 全熔断:降级返回主 endpoint(总比无 model 好,maxRetries 兜底)
 return endpoints[0] ?? aiConfig.baseUrl;
}

/** 按 modelId 获取聊天模型(自动选健康 endpoint)。 */
export function getChatModel(modelId: string) {
 const baseUrl = selectEndpoint();
 lastSelectedEndpoint = baseUrl;
 return getProvider(baseUrl)(modelId);
}

/**
 * 标记当前 endpoint 失败(route onError 调)。
 * 失败计数超阈值 → 熔断 60s,下次 getChatModel 切备用。
 */
export function markCurrentEndpointFailed(): void {
 if (!lastSelectedEndpoint) return;
 const h = getHealth(lastSelectedEndpoint);
 h.failCount += 1;
 if (h.failCount >= FAIL_THRESHOLD) {
 h.disabledUntil = Date.now() + COOLDOWN_MS;
 logger.warn("[provider] endpoint 熔断,切备用", {
 endpoint: lastSelectedEndpoint,
 failCount: h.failCount,
 cooldownMs: COOLDOWN_MS,
 });
 }
}

/** 测试用:重置健康状态 + lastSelected。 */
export function _resetEndpointHealthForTest(): void {
 health.clear();
 lastSelectedEndpoint = null;
}
