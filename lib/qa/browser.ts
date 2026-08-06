/**
 * Stage A：Playwright 浏览器生命周期（蓝图 §8 预览与 QA / plan §5）。
 *
 * 设计取舍（plan §1 决策）：
 * - 用 `playwright` 全包（非 `playwright-core`），仅 chromium。浏览器经
 * `pnpm playwright install` 部署期安装；运行时**只检查可用性**，不自动下载。
 * - 浏览器在 **host 侧**跑（打 preview localhost url；container 模式打映射端口），
 * 不在容器内装浏览器。
 * - 进程内单例 browser 实例（对齐 preview/container 单例模式），复用跨检查；
 * `isBrowserAvailable()` 结果缓存（gate 每次交付只探一次）。
 *
 * 可测性：所有检查模块（capture/browser-check/responsive/a11y）只依赖本模块导出的
 * `openQaPage` / `isBrowserAvailable` 抽象，单测以 `vi.mock("@/lib/qa/browser")` 注入
 * 假 page，**不真实 launch 浏览器**。
 *
 * 动态 import：`await import("playwright")` 延迟到首次调用，使模块顶层零副作用——
 * 既不触发 build 时的浏览器探测，也让本模块在 playwright 未装的测试环境安全加载。
 */
import { qaConfig } from "@/lib/config";
import type {
 QaConsoleLevel,
 QaConsoleMessage,
 QaNetworkResponse,
 QaPage,
 QaPageHooks,
 QaStorageState,
 QaViewport,
} from "@/lib/desktop/qa-schema";
import { logger } from "@/lib/logger";

/**
 * ：QA schema 类型从 `lib/desktop/qa-schema` 统一导出（Server/Desktop 共享）。
 *
 * 以下 re-export 保持 `@/lib/qa/browser` 的现有导入路径兼容：
 * - `QaViewport` / `QaPage` / `QaPageHooks` / `QaStorageState`：底层原语
 * - `QaConsoleLevel` / `QaConsoleMessage`（替代旧 `QaConsoleMsg`，字段 `type` → `level`）
 * - `QaNetworkResponse`（替代旧 `QaResponse`，含 method/mimeType 富信息）
 */
export type {
 QaConsoleLevel,
 QaConsoleMessage,
 QaNetworkResponse,
 QaPage,
 QaPageHooks,
 QaStorageState,
 QaViewport,
} from "@/lib/desktop/qa-schema";

/** 默认 viewport 高度（宽度由 qaConfig.viewports 给出）。 */
const DEFAULT_VIEWPORT_HEIGHT = 720;

/** 由宽度构造 viewport（高度默认 720，覆盖 mobile/tablet/desktop 主体内容）。 */
export function viewportOf(width: number, height = DEFAULT_VIEWPORT_HEIGHT): QaViewport {
 return { width, height };
}

// ─── 单例 browser + 可用性缓存 ───────────────────────────────

type PlaywrightBrowser = {
 close(): Promise<void>;
 newContext(opts: {
 viewport: QaViewport;
 extraHTTPHeaders?: Record<string, string>;
 storageState?: QaStorageState;
 }): Promise<unknown>;
};

type PlaywrightPage = {
 goto(url: string, opts: { timeout?: number; waitUntil?: string }): Promise<unknown>;
 screenshot(opts: { fullPage?: boolean; type?: string }): Promise<Buffer>;
 evaluate<T>(script: string): Promise<T>;
 close(): Promise<void>;
 on(event: string, handler: (...args: never[]) => void): void;
};

type PlaywrightChromium = {
 launch(opts: { headless?: boolean; args?: string[] }): Promise<PlaywrightBrowser>;
};

let browserInstance: PlaywrightBrowser | null = null;
let browserLaunchPromise: Promise<PlaywrightBrowser | null> | null = null;

async function loadChromium(): Promise<PlaywrightChromium | null> {
 try {
 const mod = (await import("playwright")) as { chromium?: PlaywrightChromium };
 return mod.chromium ?? null;
 } catch (error) {
 logger.warn("[qa] playwright 不可用（未安装或加载失败）", {
 error: error instanceof Error ? error.message : String(error),
 });
 return null;
 }
}

/**
 * 获取单例 browser 实例（惰性 launch）。不可用返回 null（不抛——由调用方决定 fail-closed）。
 *
 * launch 失败不会永久缓存 null——会清空 promise 允许下次重试。
 * 原因：Next.js dev server 首次 import("playwright") 可能因 Turbopack 热更新
 * 或模块解析时序瞬时失败，但后续重试能成功。永久 fail-closed 会导致整个进程
 * 生命周期内所有 QA gate 都被阻断（已验证：事件日志 6 次 browser_unavailable）。
 */
export async function getBrowser(): Promise<PlaywrightBrowser | null> {
 if (browserInstance) return browserInstance;
 if (browserLaunchPromise) return browserLaunchPromise;
 browserLaunchPromise = (async () => {
 const chromium = await loadChromium();
 if (!chromium) {
 // loadChromium 失败 → 清空 promise 允许下次重试（不永久缓存）
 browserLaunchPromise = null;
 return null;
 }
 try {
 const browser = await chromium.launch({
 headless: true,
 args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
 });
 browserInstance = browser;
 // 进程退出时 best-effort 关闭，杜绝 orphan 浏览器进程。
 process.once("beforeExit", () => {
 browser.close().catch(() => {});
 });
 return browser;
 } catch (error) {
 // launch 失败 → 清空 promise 允许下次重试（不永久缓存 null）
 browserLaunchPromise = null;
 logger.warn("[qa] chromium 启动失败（下次将重试）", {
 error: error instanceof Error ? error.message : String(error),
 });
 return null;
 }
 })();
 return browserLaunchPromise;
}

/**
 * 检查 Playwright 浏览器是否可用（惰性 launch，失败不缓存——允许重试）。
 * gate 启用且本函数返回 false → 调用方按 `QA_BROWSER_REQUIRED` fail-closed 或跳过。
 *
 * 注意：与旧实现不同，本函数不再缓存 false 结果。原因：Turbopack dev server
 * 首次加载 playwright 可能瞬时失败，但后续重试能成功。永久缓存 false 会导致
 * 整个进程生命周期内 QA gate 全部 fail-closed（生产事故级 bug）。
 */
export async function isBrowserAvailable(): Promise<boolean> {
 const browser = await getBrowser();
 return browser !== null;
}

// ─── page 工厂 ──────────────────────────────────────────────

// ─── 浏览器并发控制 ───────────────────────────
//
// openQaPage 经信号量限流，防多 thread 同时交付 / 多 viewport 并发开 page 导致 Playwright
// 资源争抢 OOM 或 launch 失败。限流值 qaConfig.maxBrowserConcurrency（默认 2）。
// 信号量在 openQaPage 内部 acquire，page.close() 时释放（对调用方透明）。

class CountingSemaphore {
 private active = 0;
 private readonly waiters: Array<() => void> = [];
 constructor(private readonly max: number) {}
 async acquire(): Promise<void> {
 if (this.active < this.max) {
 this.active++;
 return;
 }
 await new Promise<void>((resolve) => this.waiters.push(resolve));
 this.active++;
 }
 release(): void {
 this.active = Math.max(0, this.active - 1);
 const next = this.waiters.shift();
 if (next) next();
 }
}

let pageSemaphore: CountingSemaphore | null = null;
function getPageSemaphore(): CountingSemaphore {
 if (!pageSemaphore) pageSemaphore = new CountingSemaphore(qaConfig.maxBrowserConcurrency);
 return pageSemaphore;
}

/**
 * 打开一个带指定 viewport 的 page，挂载 console/pageerror/response 钩子。
 * 调用方用完必须 `page.close()`（释放 context + 信号量，不复用——viewport/钩子按检查定制）。
 *
 * 经 maxBrowserConcurrency 信号量限流，超限排队等待；page.close() 释放信号量。
 */
export async function openQaPage(viewport: QaViewport, hooks: QaPageHooks = {}): Promise<QaPage> {
 const sem = getPageSemaphore();
 await sem.acquire();
 const browser = await getBrowser();
 if (!browser) {
 sem.release();
 throw new Error("Playwright 浏览器不可用");
 }
 const context = (await browser.newContext({
 viewport,
 ...(hooks.headers ? { extraHTTPHeaders: hooks.headers } : {}),
 ...(hooks.storageState ? { storageState: hooks.storageState } : {}),
 })) as {
 newPage(): Promise<PlaywrightPage>;
 close(): Promise<void>;
 };
 const page = await context.newPage();

 if (hooks.onConsole) {
 page.on("console", (msg: never) => {
 const m = msg as { type(): string; text(): string };
 // ：`level` 对齐 ConsoleEntry（Playwright msg.type() 返回
 // "error"/"warning"/"info"/"log" 等字符串，"debug"/"trace" 等非关键级别归入 "log"）。
 const rawType = m.type();
 const level: QaConsoleLevel =
 rawType === "error" || rawType === "warning" || rawType === "info" || rawType === "log"
 ? (rawType as QaConsoleLevel)
 : "log";
 hooks.onConsole?.({ level, text: m.text() });
 });
 }
 if (hooks.onPageError) {
 page.on("pageerror", (err: never) => {
 hooks.onPageError?.(String((err as Error)?.message ?? err));
 });
 }
 if (hooks.onResponse) {
 page.on("response", (res: never) => {
 // ：补充 method/statusText/mimeType 富信息（best-effort，缺失不阻断）。
 const r = res as {
 url(): string;
 status(): number;
 statusText?(): string;
 headers?(): Record<string, string>;
 request?(): { method?(): string };
 };
 const headers = r.headers?.() ?? {};
 // 经可选链安全取值，避免调用 possibly-undefined 的函数
 const method = r.request?.()?.method?.();
 const statusText = r.statusText?.();
 const mimeType = headers["content-type"];
 hooks.onResponse?.({
 url: r.url(),
 status: r.status(),
 ...(method ? { method } : {}),
 ...(statusText ? { statusText } : {}),
 ...(mimeType ? { mimeType } : {}),
 });
 });
 }

 return {
 viewport,
 async goto(url, timeoutMs) {
 await page.goto(url, { timeout: timeoutMs ?? qaConfig.timeoutMs, waitUntil: "load" });
 },
 async screenshotFullPage() {
 return page.screenshot({ fullPage: true, type: "png" });
 },
 async evaluate<T>(script: string) {
 return page.evaluate<T>(script);
 },
 async close() {
 await page.close().catch(() => {});
 await context.close().catch(() => {});
 sem.release(); // 释放并发槽
 },
 };
}

/** 仅供测试：重置单例 + 信号量。 */
export function __resetQaBrowserForTest(): void {
 browserInstance = null;
 browserLaunchPromise = null;
 pageSemaphore = null;
}

// ：QA storageState 派生已移除。
// 原 V9 从 UserBrowserProfile 解密登录态供 QA 隐藏 context 继承，V10 删除服务端
// 用户浏览器链路后无数据来源。QaPageHooks.storageState 字段保留（Desktop
// QA 隐藏 WebContents 可经 Desktop RPC 派生登录态后注入 openQaPage）。
