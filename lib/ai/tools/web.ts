import { executeToolRun } from "@/lib/ai/tool-runtime";
import { appendThreadEvent } from "@/lib/db/queries";
import { searchDocs as runSearchDocs } from "@/lib/external/docs";
import { domainEvaluate, rawFetch } from "@/lib/external/fetch";
import { webSearch as runWebSearch } from "@/lib/external/search";
import { tool } from "ai";
import { z } from "zod";

/**
 * Stage B：web / docs 工具（蓝图 ）。
 *
 * 三个工具均经 `executeToolRun` 包裹：
 * - webFetch：权限经 `domainEvaluate` 覆盖（域名治理）——域内 allow / 域外 ask /
 * 黑名单 deny / 空 allowlist 全 deny。原文落 artifact，返回确定性抽取正文 + 来源标记；
 * 大网页若抽取后仍超 toolOutputThreshold，由 a oversized 机制自动摘要。
 * 每次成功抓取追加 `external.fetched` 事件供 Studio 审计。
 * - webSearch / searchDocs：无单 URL 维度，治理由 runner 内部（空 allowlist → denied）
 * 表达；经默认 evaluatePermission（无规则 → allow）放行后由 runner 决定 allow/deny。
 */

/** 构造 web/docs 工具集（仅需 threadId）。 */
export function buildWebTools(threadId: string) {
 return {
 webFetch: tool({
 description:
 "抓取一个网页 URL 并确定性抽取正文。仅允许域名 allowlist 内的站点；域外需审批。" +
 "返回正文摘要 + 来源标记（sourceUrl/fetchedAt/expiresAt/contentHash）；原文落 artifact，超长自动摘要。",
 inputSchema: z.object({
 url: z.string().describe("要抓取的完整 URL，如 https://react.dev/learn"),
 }),
 execute: async ({ url }) => {
 try {
 return await executeToolRun(
 threadId,
 "webFetch",
 { url },
 async (signal) => {
 const r = await rawFetch({ url, threadId });
 if (!r.ok) return { ok: false, url, error: r.error };
 // 追加 external.fetched 事件（供 Studio external 审计；fail-open 不阻断）
 try {
 await appendThreadEvent(threadId, "external.fetched", {
 sourceUrl: r.source.sourceUrl,
 fetchedAt: r.source.fetchedAt,
 expiresAt: r.source.expiresAt,
 contentHash: r.source.contentHash,
 artifactPath: r.source.artifactPath,
 contentType: r.contentType,
 bytes: r.bytes,
 truncated: r.truncated,
 });
 } catch {
 // 事件写入失败不阻断工具结果
 }
 return {
 ok: true,
 url: r.url,
 text: r.text,
 truncated: r.truncated,
 bytes: r.bytes,
 contentType: r.contentType,
 sourceUrl: r.source.sourceUrl,
 fetchedAt: r.source.fetchedAt,
 expiresAt: r.source.expiresAt,
 contentHash: r.source.contentHash,
 artifactPath: r.source.artifactPath,
 };
 },
 { permissionKey: "web.fetch", evaluate: domainEvaluate },
 );
 } catch (error) {
 return { ok: false, url, error: (error as Error).message };
 }
 },
 }),

 webSearch: tool({
 description:
 "网络搜索（DuckDuckGo）。返回结构化结果 [{title,url,snippet}]，按域名 allowlist 过滤；" +
 "空 allowlist 全 deny，域外结果不暴露。带来源标记。",
 inputSchema: z.object({
 query: z.string().describe("搜索关键词"),
 }),
 execute: async ({ query }) => {
 try {
 return await executeToolRun(threadId, "webSearch", { query }, async (signal) => {
 const r = await runWebSearch({ query, threadId });
 if (!r.ok) return r;
 // 追加 external.searched 事件供 Studio external 审计（fail-open）
 await appendThreadEvent(threadId, "external.searched", {
 tool: "webSearch",
 query,
 resultCount: r.results.length,
 sourceUrl: r.source.sourceUrl,
 }).catch(() => {});
 return {
 ok: true,
 query: r.query,
 results: r.results,
 sourceUrl: r.source.sourceUrl,
 fetchedAt: r.source.fetchedAt,
 expiresAt: r.source.expiresAt,
 contentHash: r.source.contentHash,
 };
 });
 } catch (error) {
 return { ok: false, query, error: (error as Error).message };
 }
 },
 }),

 searchDocs: tool({
 description:
 "在官方文档域 allowlist 内搜索（SNOW_DOCS_DOMAINS）。优先检索 SNOW_DOCS_INDEX_PATH 本地全文索引，" +
 "索引支持构建/刷新/版本校验；未配置索引时降级为域名限定网络搜索。文档域未配置时全 deny。带来源标记。",
 inputSchema: z.object({
 query: z.string().describe("文档搜索关键词"),
 }),
 execute: async ({ query }) => {
 try {
 return await executeToolRun(threadId, "searchDocs", { query }, async (signal) => {
 const r = await runSearchDocs({ query, threadId });
 if (!r.ok) return r;
 // 追加 external.docs_searched 事件供 Studio external 审计（fail-open）
 await appendThreadEvent(threadId, "external.docs_searched", {
 tool: "searchDocs",
 query,
 resultCount: r.results.length,
 sourceUrl: r.source.sourceUrl,
 }).catch(() => {});
 return {
 ok: true,
 query: r.query,
 results: r.results,
 sourceUrl: r.source.sourceUrl,
 fetchedAt: r.source.fetchedAt,
 expiresAt: r.source.expiresAt,
 contentHash: r.source.contentHash,
 };
 });
 } catch (error) {
 return { ok: false, query, error: (error as Error).message };
 }
 },
 }),
 };
}
