/**
 * ：Desktop / Server 共享脱敏纯函数。
 *
 * 实现 03-agent-bridge-security.md §8 与 02-desktop-browser-architecture.md §7
 * 规定的脱敏与上限规则。先在 Desktop 执行（首次脱敏），Server 再调用同一模块
 * 执行同等规则（防绕过）。
 *
 * 安全约束：
 * - 密码输入框只返回存在性和类型，永远不返回 value
 * - Cookie、token、Authorization、Set-Cookie、银行卡、验证码不进入模型 / 审计 / 日志
 * - DOM、accessibility、console、network 结果同时受字节上限和条目上限约束
 * - 截图、大 DOM、network body 不进 RPC，只传引用和摘要
 *
 * 模块为纯函数集合，无副作用，可在主进程、renderer、Server 复用。
 */

/**
 * 默认字节 / 条目上限。
 *
 * 与 03-agent-bridge-security.md §8 一致。
 */
export const DEFAULT_LIMITS = {
 /** snapshot 文本上限 */
 maxTextLength: 2000,
 /** page text 上限 */
 maxPageTextLength: 5000,
 /** console 条目数上限（默认 50，最大 200 由调用方校验） */
 maxConsoleEntries: 50,
 /** network 条目数上限（默认 50，最大 200 由调用方校验） */
 maxNetworkEntries: 50,
 /** DOM 摘要字节上限 */
 maxDomBytes: 50000,
} as const;

/**
 * 敏感字段名（不区分大小写匹配）。
 *
 * 用于判断表单字段名 / query 参数名是否需要脱敏。
 */
export const SENSITIVE_FIELD_NAMES = [
 "password",
 "passwd",
 "pwd",
 "secret",
 "token",
 "authorization",
 "auth",
 "apikey",
 "api_key",
 "creditcard",
 "cardnumber",
 "cvv",
 "cvc",
] as const;

/**
 * 敏感响应头（不传递给模型）。
 *
 * Set-Cookie、Authorization、Cookie 等始终在脱敏阶段移除。
 */
export const SENSITIVE_HEADERS = [
 "set-cookie",
 "authorization",
 "cookie",
 "proxy-authorization",
 "x-api-key",
 "x-auth-token",
] as const;

/**
 * 判断字段名是否敏感（不区分大小写，子串匹配）。
 *
 * 同时覆盖 `password`、`user_password`、`oldToken` 等命名变体。
 */
export function isSensitiveFieldName(name: string): boolean {
 if (!name) return false;
 const lower = name.toLowerCase();
 for (const sensitive of SENSITIVE_FIELD_NAMES) {
 if (lower.includes(sensitive)) return true;
 }
 return false;
}

/**
 * 判断响应头名是否敏感（不区分大小写，子串匹配）。
 */
export function isSensitiveHeader(name: string): boolean {
 if (!name) return false;
 const lower = name.toLowerCase();
 for (const sensitive of SENSITIVE_HEADERS) {
 if (lower.includes(sensitive)) return true;
 }
 return false;
}

/**
 * 脱敏后的表单字段。
 *
 * value 永远为字面量 "[REDACTED]"，仅暴露字段存在性和 type。
 */
export interface RedactedFormField {
 name: string;
 type: string;
 /** 固定为 "[REDACTED]"，调用方不应期望拿到原值 */
 value: string;
}

/**
 * 脱敏表单字段值：返回存在性 + type，永远不返回 value。
 *
 * 调用方应先用 isSensitiveFieldName 判断是否需要脱敏；
 * 本函数对任意输入都返回 [REDACTED]，确保 fail-safe。
 */
export function redactFormField(name: string, type: string, _value: unknown): RedactedFormField {
 return {
 name,
 type,
 value: "[REDACTED]",
 };
}

/**
 * 截断文本到最大字符数。
 *
 * 超出 maxLength 时尾部附加 "..."，总长度不超过 maxLength。
 * maxLength 小于 3 时仅返回前 maxLength 个字符（无法容纳省略号）。
 */
export function truncateText(text: string, maxLength: number): string {
 if (text.length <= maxLength) return text;
 if (maxLength <= 0) return "";
 if (maxLength <= 3) return text.slice(0, maxLength);
 return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * 截断条目列表到最大条目数。
 *
 * 保留原数组顺序和引用，返回新数组（不修改入参）。
 */
export function truncateEntries<T>(entries: T[], maxEntries: number): T[] {
 if (maxEntries <= 0) return [];
 return entries.slice(0, maxEntries);
}

/**
 * 脱敏网络请求头：移除敏感头（不区分大小写）。
 *
 * 返回新对象，不修改入参。保留 content-type、content-length 等公开头。
 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
 const result: Record<string, string> = {};
 for (const [key, value] of Object.entries(headers)) {
 if (!isSensitiveHeader(key)) {
 result[key] = value;
 }
 }
 return result;
}

/**
 * Console 条目结构。
 */
export interface ConsoleEntry {
 level: "error" | "warning" | "pageerror" | "log" | "info";
 text: string;
 url?: string;
 lineNumber?: number;
}

/**
 * 脱敏 console 消息：移除 stack trace 中的文件路径细节。
 *
 * 浏览器 console.error / pageerror 通常包含 ` at fn (http://host/file.js:line:col)`
 * 形式的 stack trace，可能泄露内部 URL、文件路径或敏感参数。
 * 本函数保留首行消息，移除所有以 ` at ` 开头的 stack frame 行。
 */
export function sanitizeConsoleEntry(entry: ConsoleEntry): ConsoleEntry {
 const lines = entry.text.split("\n");
 const filtered = lines.filter((line) => !/^\s+at\s/.test(line));
 return {
 ...entry,
 text: filtered.join("\n"),
 };
}

/**
 * 网络请求条目结构。
 */
export interface NetworkEntry {
 url: string;
 method: string;
 status: number;
 statusText?: string;
 mimeType?: string;
 headers?: Record<string, string>;
 /** 默认不读取；如调用方读取了，本函数会强制置 null */
 body?: string | null;
 duration?: number;
}

/**
 * 脱敏网络请求条目：移除敏感头，body 置 null，URL 移除敏感 query 参数。
 *
 * 返回新对象，不修改入参。
 */
export function sanitizeNetworkEntry(entry: NetworkEntry): NetworkEntry {
 const result: NetworkEntry = {
 ...entry,
 url: sanitizeUrl(entry.url),
 body: null,
 };
 if (entry.headers) {
 result.headers = sanitizeHeaders(entry.headers);
 }
 return result;
}

/**
 * 脱敏 DOM 摘要：移除 inline event handlers 和 data: URI。
 *
 * - 移除 `onclick`、`onload`、`onerror` 等 `on*` 属性（双引号 / 单引号）
 * - 移除 `data:` URI（可能携带凭证或 HTML 注入负载）
 *
 * 注意：本函数只做正则层面的脱敏，不保证产出合法 HTML。
 * 调用方仍应在浏览器上下文使用 structured summary 而非整页 HTML。
 */
export function sanitizeDomSummary(html: string): string {
 return (
 html
 // 移除 inline event handler：on\w+="..." 或 on\w+='...'
 .replace(/\s+on[a-zA-Z]+\s*=\s*"[^"]*"/g, "")
 .replace(/\s+on[a-zA-Z]+\s*=\s*'[^']*'/g, "")
 // 移除 data: URI（出现在 src/href 等 URL 上下文中）
 .replace(/data:[^"'\s)]+/g, "")
 );
}

/**
 * 脱敏 URL：移除 query string 中的 token/password 等敏感参数。
 *
 * 使用 SENSITIVE_FIELD_NAMES 做大小写不敏感匹配。
 * URL 无效时原样返回（不抛错），便于在日志/调试场景安全调用。
 */
export function sanitizeUrl(url: string): string {
 if (!url) return url;
 let parsed: URL;
 try {
 parsed = new URL(url);
 } catch {
 return url;
 }
 const params = new URLSearchParams(parsed.search);
 for (const key of [...params.keys()]) {
 if (isSensitiveFieldName(key)) {
 params.delete(key);
 }
 }
 parsed.search = params.toString();
 return parsed.toString();
}

/**
 * 综合脱敏：对任意命令结果应用脱敏规则。
 *
 * 根据命令名分发到对应脱敏逻辑：
 * - browser.getConsole：sanitizeConsoleEntry 每条 + 截断到 maxConsoleEntries
 * - browser.getNetwork：sanitizeNetworkEntry 每条 + 截断到 maxNetworkEntries
 * - browser.snapshot / browser.getAccessibilityTree：sanitizeDomSummary + 截断
 * - browser.getPageMetadata：截断到 maxPageTextLength
 * - browser.screenshot：移除原始字节，替换为引用占位
 * - browser.getTabs：sanitizeUrl 每条 URL
 *
 * null / undefined 原样返回；未知命令原样返回结果。
 */
export function redactCommandResult(command: string, result: unknown): unknown {
 if (result === null || result === undefined) return result;

 switch (command) {
 case "browser.getConsole":
 return redactConsoleResult(result);
 case "browser.getNetwork":
 return redactNetworkResult(result);
 case "browser.snapshot":
 case "browser.getAccessibilityTree":
 return redactDomResult(result, DEFAULT_LIMITS.maxTextLength);
 case "browser.getPageMetadata":
 return redactPageTextResult(result);
 case "browser.screenshot":
 return redactScreenshotResult(result);
 case "browser.getTabs":
 return redactTabsResult(result);
 default:
 return result;
 }
}

/**
 * 脱敏 browser.getConsole 结果。
 *
 * 接受 ConsoleEntry[] 或 { entries: ConsoleEntry[] } 两种形状。
 */
function redactConsoleResult(result: unknown): unknown {
 if (Array.isArray(result)) {
 const entries = result.map((e) => (isConsoleEntryLike(e) ? sanitizeConsoleEntry(e) : e));
 return truncateEntries(entries, DEFAULT_LIMITS.maxConsoleEntries);
 }
 if (isObjectWithEntries(result)) {
 const entries = result.entries as unknown[];
 const sanitized = entries.map((e) =>
 isConsoleEntryLike(e) ? sanitizeConsoleEntry(e as ConsoleEntry) : e,
 );
 return {
 ...result,
 entries: truncateEntries(sanitized, DEFAULT_LIMITS.maxConsoleEntries),
 };
 }
 return result;
}

/**
 * 脱敏 browser.getNetwork 结果。
 *
 * 接受 NetworkEntry[] 或 { entries: NetworkEntry[] } 两种形状。
 */
function redactNetworkResult(result: unknown): unknown {
 if (Array.isArray(result)) {
 const entries = result.map((e) => (isNetworkEntryLike(e) ? sanitizeNetworkEntry(e) : e));
 return truncateEntries(entries, DEFAULT_LIMITS.maxNetworkEntries);
 }
 if (isObjectWithEntries(result)) {
 const entries = result.entries as unknown[];
 const sanitized = entries.map((e) =>
 isNetworkEntryLike(e) ? sanitizeNetworkEntry(e as NetworkEntry) : e,
 );
 return {
 ...result,
 entries: truncateEntries(sanitized, DEFAULT_LIMITS.maxNetworkEntries),
 };
 }
 return result;
}

/**
 * 脱敏 DOM / accessibility 结果（snapshot、getAccessibilityTree）。
 *
 * 接受 string 或 { html: string } / { text: string } 形状。
 */
function redactDomResult(result: unknown, maxLength: number): unknown {
 if (typeof result === "string") {
 return sanitizeDomSummary(truncateText(result, maxLength));
 }
 if (typeof result === "object" && result !== null) {
 const obj = result as Record<string, unknown>;
 if (typeof obj.html === "string") {
 return { ...obj, html: sanitizeDomSummary(truncateText(obj.html, maxLength)) };
 }
 if (typeof obj.text === "string") {
 return { ...obj, text: sanitizeDomSummary(truncateText(obj.text, maxLength)) };
 }
 }
 return result;
}

/**
 * 脱敏 browser.getPageMetadata 结果（仅截断 page text，不做 DOM 脱敏）。
 */
function redactPageTextResult(result: unknown): unknown {
 if (typeof result === "string") {
 return truncateText(result, DEFAULT_LIMITS.maxPageTextLength);
 }
 if (typeof result === "object" && result !== null) {
 const obj = result as Record<string, unknown>;
 if (typeof obj.text === "string") {
 return { ...obj, text: truncateText(obj.text, DEFAULT_LIMITS.maxPageTextLength) };
 }
 }
 return result;
}

/**
 * 脱敏 browser.screenshot 结果：移除原始字节，替换为引用占位。
 *
 * 截图应写入 Desktop 临时文件，RPC 只传引用 + 摘要，不传 base64。
 */
function redactScreenshotResult(result: unknown): unknown {
 if (typeof result === "string") {
 return { ref: "[REDACTED_RAW_BYTES]", format: "png" };
 }
 if (typeof result === "object" && result !== null) {
 const obj = result as Record<string, unknown>;
 // 移除原始字节字段（data / base64 / bytes / bytesBase64），替换为 ref 占位
 const { data, base64, bytes, bytesBase64, ...rest } = obj;
 if (
 data !== undefined ||
 base64 !== undefined ||
 bytes !== undefined ||
 bytesBase64 !== undefined
 ) {
 return { ...rest, ref: "[REDACTED_RAW_BYTES]" };
 }
 return rest;
 }
 return result;
}

/**
 * 脱敏 browser.getTabs 结果：对每个 tab 的 url 应用 sanitizeUrl。
 *
 * 接受 TabMetadata[] 或 { tabs: TabMetadata[], activeTabId?: string } 两种形状。
 */
function redactTabsResult(result: unknown): unknown {
 if (Array.isArray(result)) {
 return sanitizeTabList(result);
 }
 if (typeof result === "object" && result !== null && !Array.isArray(result)) {
 const obj = result as Record<string, unknown>;
 if (Array.isArray(obj.tabs)) {
 return { ...obj, tabs: sanitizeTabList(obj.tabs) };
 }
 }
 return result;
}

/**
 * 对 tab 列表中的每个 tab URL 应用 sanitizeUrl。
 */
function sanitizeTabList(tabs: unknown[]): unknown[] {
 return tabs.map((tab) => {
 if (
 tab &&
 typeof tab === "object" &&
 typeof (tab as Record<string, unknown>).url === "string"
 ) {
 return {
 ...(tab as object),
 url: sanitizeUrl((tab as Record<string, unknown>).url as string),
 };
 }
 return tab;
 });
}

/** 类型守卫：判断对象是否为 ConsoleEntry。 */
function isConsoleEntryLike(value: unknown): value is ConsoleEntry {
 return (
 typeof value === "object" &&
 value !== null &&
 !Array.isArray(value) &&
 typeof (value as ConsoleEntry).level === "string" &&
 typeof (value as ConsoleEntry).text === "string"
 );
}

/** 类型守卫：判断对象是否为 NetworkEntry。 */
function isNetworkEntryLike(value: unknown): value is NetworkEntry {
 return (
 typeof value === "object" &&
 value !== null &&
 !Array.isArray(value) &&
 typeof (value as NetworkEntry).url === "string" &&
 typeof (value as NetworkEntry).method === "string" &&
 typeof (value as NetworkEntry).status === "number"
 );
}

/** 类型守卫：判断对象是否为 { entries: unknown[] } 形状。 */
function isObjectWithEntries(value: unknown): value is { entries: unknown[] } {
 return (
 typeof value === "object" &&
 value !== null &&
 Array.isArray((value as { entries?: unknown }).entries)
 );
}
