import { qaConfig } from "@/lib/config";
import { type QaFailure, type QaRunner, saveQaReport, saveScreenshot } from "@/lib/qa/artifact";
import { type QaStorageState, openQaPage, viewportOf } from "@/lib/qa/browser";

/**
 * Stage B：runBrowserCheck——确定性浏览器检查（plan §6 / §1 决策）。
 *
 * 对每个 viewport 打开 url，捕获：
 * - console error（`page.on('console')` type=error；warning 不阻；资源加载泛化错误交给 response 处理）
 * - pageerror（未捕获异常）
 * - network 4xx/5xx（排除 `QA_404_WHITELIST` 路径匹配，避免 favicon/fonts 误杀）
 * - 白屏（body innerHTML 空 / 无 DOM 节点）
 *
 * 全部确定性规则，**不调 LLM**。`ok` = 无任何失败。证据：各 viewport 截图 + console/network
 * JSON 落 artifact。失败项带 viewport + detail，供 gate / agent 读取。
 */

export interface BrowserCheckResult {
 ok: boolean;
 kind: "browser";
 failures: QaFailure[];
 viewports: number[];
 durationMs: number;
 artifactPath?: string | null;
 runner?: QaRunner;
}

function errMsg(error: unknown): string {
 return error instanceof Error ? error.message : String(error);
}

/**
 * 附属资源 HTTP 失败白名单命中。
 * 原子串匹配会误白名单（配 "icon" 会放行 /api/icons）。改为 URL 路径前缀匹配：
 * 取 URL pathname，白名单条目作为路径前缀（不含 host/query）。大小写不敏感。
 */
function isWhitelistedHttpFailure(url: string): boolean {
 const list = qaConfig.notFound404Whitelist;
 if (list.length === 0) return false;
 let pathname: string;
 try {
 pathname = new URL(url).pathname.toLowerCase();
 } catch {
 pathname = url.toLowerCase().split("?")[0] ?? url.toLowerCase();
 }
 return list.some((entry) => {
 const normalized = entry.toLowerCase().trim();
 if (normalized.startsWith(".")) return pathname.endsWith(normalized);
 // 规范化为带前导 / 的路径段，与 pathname 对齐（entry "favicon.ico" → "/favicon.ico"）
 const e = `/${normalized.replace(/^\/+/, "")}`;
 return pathname === e || pathname.startsWith(`${e}/`);
 });
}

function isResourceLoadConsoleError(text: string): boolean {
 return /^Failed to load resource: the server responded with a status of \d{3}/.test(text);
}

/** 白屏判定脚本：返回 body innerHTML、DOM 节点数、可见文本长度。 */
const BLANK_SCRIPT =
 "(() => ({ bodyHtml: document.body ? document.body.innerHTML : '', " +
 "nodeCount: document.querySelectorAll('*').length, " +
 "textLength: (document.body && document.body.innerText) ? document.body.innerText.trim().length : 0 }))()";

interface BlankProbe {
 bodyHtml: string;
 nodeCount: number;
 textLength: number;
}

function isBlank(probe: BlankProbe): boolean {
 // body innerHTML 空 / 无 DOM 节点 / 既无文本也无任何元素 → 白屏
 return probe.bodyHtml.trim() === "" || probe.nodeCount === 0;
}

export async function runBrowserCheckUrl(opts: {
 url: string;
 previewToken?: string;
 threadId: string;
 checkId: string;
 viewports?: number[];
 /** V9 阶段 9：从 UserBrowserProfile 派生的登录态，用于测试需登录的页面。 */
 storageState?: QaStorageState;
}): Promise<BrowserCheckResult> {
 const viewports = opts.viewports ?? qaConfig.viewports;
 const start = Date.now();
 const failures: QaFailure[] = [];
 const evidence: Array<{
 viewport: number;
 consoleErrors: string[];
 pageErrors: string[];
 httpErrors: string[];
 blank: boolean;
 nodeCount: number;
 }> = [];

 for (const width of viewports) {
 const consoleErrors: string[] = [];
 const pageErrors: string[] = [];
 const httpErrors: string[] = [];

 let page: Awaited<ReturnType<typeof openQaPage>> | null = null;
 try {
 page = await openQaPage(viewportOf(width), {
 ...(opts.previewToken ? { headers: { "x-preview-token": opts.previewToken } } : {}),
 ...(opts.storageState ? { storageState: opts.storageState } : {}),
 onConsole: (m) => {
 // 仅 error 阻断（warning/info/log 不阻）
 if (m.level === "error") consoleErrors.push(m.text);
 },
 onPageError: (e) => pageErrors.push(e),
 onResponse: (r) => {
 if (r.status >= 400 && !isWhitelistedHttpFailure(r.url)) {
 httpErrors.push(`${r.method ?? "GET"} ${r.url} → ${r.status}`);
 }
 },
 });
 await page.goto(opts.url, qaConfig.timeoutMs);

 let probe: BlankProbe = { bodyHtml: "", nodeCount: 0, textLength: 0 };
 try {
 probe = await page.evaluate<BlankProbe>(BLANK_SCRIPT);
 } catch (error) {
 failures.push({
 type: "evaluate_failed",
 viewport: width,
 detail: errMsg(error),
 });
 }

 // 截图证据（best-effort，失败不阻断判定）
 const buf = await page.screenshotFullPage().catch(() => null);
 if (buf) await saveScreenshot(opts.threadId, opts.checkId, buf, width);

 for (const text of consoleErrors) {
 if (isResourceLoadConsoleError(text)) continue;
 failures.push({ type: "console_error", viewport: width, detail: text });
 }
 for (const text of pageErrors) {
 failures.push({ type: "pageerror", viewport: width, detail: text });
 }
 for (const text of httpErrors) {
 failures.push({ type: "network_http_error", viewport: width, detail: text });
 }
 if (isBlank(probe)) {
 failures.push({
 type: "blank",
 viewport: width,
 detail: "页面主体为空（body 无内容 / 无 DOM 节点）",
 });
 }
 evidence.push({
 viewport: width,
 consoleErrors,
 pageErrors,
 httpErrors,
 blank: isBlank(probe),
 nodeCount: probe.nodeCount,
 });
 } catch (error) {
 failures.push({
 type: "navigation_failed",
 viewport: width,
 detail: errMsg(error),
 });
 evidence.push({
 viewport: width,
 consoleErrors,
 pageErrors,
 httpErrors,
 blank: false,
 nodeCount: 0,
 });
 } finally {
 await page?.close().catch(() => {});
 }
 }

 const report = {
 checkId: opts.checkId,
 url: opts.url,
 viewports,
 failures,
 evidence,
 };
 const artifactPath = await saveQaReport(opts.threadId, opts.checkId, report);
 return {
 ok: failures.length === 0,
 kind: "browser",
 failures,
 viewports,
 durationMs: Date.now() - start,
 artifactPath,
 runner: "web-playwright",
 };
}
