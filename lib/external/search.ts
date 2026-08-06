import { webConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { htmlToText, urlHost } from "./fetch";
import { type ExternalSource, buildExternalSource, matchDomain } from "./source";

/**
 * webSearch（蓝图 MVP）。
 *
 * 域名限定的检索聚合：基于 DuckDuckGo HTML 接口（https://html.duckduckgo.com/html/?q=），
 * 确定性解析结果列表（不调 LLM）。结果条目再经域名 allowlist 过滤——仅返回域内可访问的
 * 结果（域外结果即使搜索引擎返回也不暴露，避免 agent 拿到无法 fetch 的链接）。
 *
 * 与 webFetch 同样的 fail-closed 治理：空 allowlist → 全 deny；黑名单含搜索引擎域 → deny。
 * searchDocs（docs.ts）复用本函数，限定到文档域子集。
 */

export type SearchResult = {
 title: string;
 url: string;
 snippet: string;
};

export type SearchOk = {
 ok: true;
 query: string;
 results: SearchResult[];
 source: ExternalSource;
};

export type SearchResult_ =
 | SearchOk
 | { ok: false; denied: true; reason: string }
 | { ok: false; awaitingApproval: true; reason: string }
 | { ok: false; error: string };

export type { SearchResult_ as WebSearchResult };

export async function webSearch(params: {
 query: string;
 threadId: string;
 /** 仅返回这些域内的结果（默认 = webConfig.domainAllowlist）。空 → 按治理返回。 */
 domainFilter?: string[];
 fetchImpl?: typeof fetch;
 maxResults?: number;
}): Promise<SearchResult_> {
 const { query } = params;
 const allowlist = params.domainFilter ?? webConfig.domainAllowlist;
 const blacklist = webConfig.domainBlacklist;
 if (blacklist.includes("duckduckgo.com")) {
 return { ok: false, denied: true, reason: "搜索引擎域被黑名单" };
 }
 if (allowlist.length === 0) {
 return { ok: false, denied: true, reason: "域名 allowlist 为空（fail-closed）" };
 }

 const fetchImpl = params.fetchImpl ?? fetch;
 const max = params.maxResults ?? 8;
 const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), webConfig.timeoutMs);
 try {
 const res = await fetchImpl(ddgUrl, {
 signal: controller.signal,
 headers: { "user-agent": "snow-harness-websearch/1.0" },
 });
 if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
 const html = await res.text();
 const results = parseDuckDuckGo(html, allowlist, blacklist, max);
 // 结构变化检测。0 结果但 HTML 非空且含 result 标记 → DDG 页面结构可能改版，
 // regex 失效。log warn 供运维排查（不阻断，仍返回空结果让上层走域内 fallback）。
 if (
 results.length === 0 &&
 html.length > 500 &&
 /result__a|result__snippet|result__url/i.test(html)
 ) {
 logger.warn(
 "[external] DuckDuckGo HTML 结构可能改版：regex 未匹配到结果但页面含 result 标记",
 {
 query,
 htmlLength: html.length,
 },
 );
 }
 const source = buildExternalSource({
 sourceUrl: ddgUrl,
 content: html,
 dynamic: true,
 });
 return { ok: true, query, results, source };
 } catch (e) {
 const msg = e instanceof Error ? e.message : String(e);
 if (msg.includes("abort"))
 return { ok: false, error: `search 超时（${webConfig.timeoutMs}ms）` };
 return { ok: false, error: msg };
 } finally {
 clearTimeout(timer);
 }
}

/**
 * 确定性解析 DuckDuckGo HTML 结果页（不调 LLM）。
 * 抽取 result anchors 的 href + 标题 + snippet 文本，再按 allowlist/blacklist 过滤。
 */
export function parseDuckDuckGo(
 html: string,
 allowlist: string[],
 blacklist: string[],
 max: number,
): SearchResult[] {
 const out: SearchResult[] = [];
 // DuckDuckGo html 结果块大致：<a class="result__a" href="...">title</a> + <a class="result__snippet">
 const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
 let m: RegExpExecArray | null;
 // biome-ignore lint/suspicious/noAssignInExpressions: 标准 regex exec 推进模式，continue 需在条件中推进
 while ((m = linkRe.exec(html)) !== null && out.length < max) {
 const rawHref = m[1];
 const rawTitle = m[2];
 if (rawHref === undefined || rawTitle === undefined) continue;
 let href = rawHref;
 // DuckDuckGo 链接常为 //duckduckgo.com/l/?uddg=<encoded>，解出真实 URL
 const uddg = href.match(/uddg=([^&]+)/);
 if (uddg?.[1]) {
 try {
 href = decodeURIComponent(uddg[1]);
 } catch {
 // 保留原值
 }
 }
 const host = urlHost(href);
 if (!host) continue;
 if (blacklist.some((d) => matchDomain(host, d))) continue;
 // allowlist 为空时不过滤（外层已 deny），非空时仅留域内
 if (allowlist.length > 0 && !allowlist.some((d) => matchDomain(host, d))) continue;
 const title = htmlToText(rawTitle).slice(0, 200);
 // snippet：在链接后查找最近的 result__snippet
 const start = m.index ?? 0;
 const after = html.slice(start, start + 2000);
 const snipMatch = after.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
 const snippet = snipMatch?.[1] ? htmlToText(snipMatch[1]).slice(0, 300) : "";
 out.push({ title, url: href, snippet });
 }
 return out;
}
