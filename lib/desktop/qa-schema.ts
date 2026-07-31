/**
 * V10 Phase 7-5：QA 结果 schema 统一层。
 *
 * 这是 Server 与 Desktop 共享的纯类型边界，无运行时依赖（与 `lib/desktop/redaction.ts`
 * 同构约束）。Web Playwright QA 与 Desktop CDP QA 产出同一形状的结果，AI 工具
 * （`lib/ai/tools/qa.ts`）、QA gate（`lib/qa/gate.ts`）、Studio QA API
 * （`app/studio/api/threads/[id]/qa/route.ts`）都依赖此 schema，不再区分产出者。
 *
 * 设计约束（02-desktop-browser-architecture.md §9）：
 * - Web 端仍使用服务端 Playwright QA，不为 Web iframe 建立桌面 RPC 依赖
 * - Desktop 端 QA 独立运行，两端只统一结果 schema
 * - Desktop 截图先落本机临时加密文件，需成为 Thread Artifact 时再上传 Server
 *
 * 命名对齐：与 `lib/desktop/redaction.ts` 的 `ConsoleEntry` / `NetworkEntry` 保持
 * 字段名一致（`level` 而非 `type`，含 `method`/`mimeType` 等富信息字段）。
 */

/** QA 检查种类（与 `thread_events.payload.kind` 字段对应）。 */
export type QaCheckKind = "browser" | "responsive" | "a11y" | "gate" | "verdict";

/** QA 检查结果标识（单次检查唯一，用于 artifact 文件名与事件关联）。 */
export type QaCheckId = string;

/** QA 产出者标识，便于审计区分 Web Playwright 与 Desktop CDP。 */
export type QaRunner = "web-playwright" | "desktop-cdp";

/** 视口尺寸（width × height）。 */
export interface QaViewport {
  width: number;
  height: number;
}

/** Console 消息级别（含未捕获异常 pageerror）。与 `ConsoleEntry.level` 对齐。 */
export type QaConsoleLevel = "error" | "warning" | "pageerror" | "log" | "info";

/**
 * Console 消息（统一形状，Web/Desktop 共用）。
 *
 * 与 `lib/desktop/redaction.ts` 的 `ConsoleEntry` 字段一致：
 * - `level`（非 `type`）映射 Playwright `msg.type()` 与 CDP `Runtime.consoleAPICalled.type`
 * - `pageerror` 经独立钩子（`onPageError`）触发，但归入同一 level 枚举
 */
export interface QaConsoleMessage {
  level: QaConsoleLevel;
  text: string;
  url?: string;
  lineNumber?: number;
}

/**
 * Network 响应（统一形状，含 method/mimeType/duration 富信息）。
 *
 * Desktop CDP 天然提供富信息；Web Playwright 经 `response.request().method()`
 * best-effort 填充（可选字段，缺失不阻断）。
 */
export interface QaNetworkResponse {
  url: string;
  status: number;
  method?: string;
  statusText?: string;
  mimeType?: string;
  duration?: number;
}

/**
 * QA 登录态（V10 暂未启用，字段保留供 Desktop RPC 派生）。
 *
 * 与 Playwright `storageState` 同构，QA 隐藏 context 可继承用户登录态。
 */
export interface QaStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/**
 * 抽象 QA Page 句柄——检查模块只依赖此接口，不直接碰 Playwright/CDP 类型。
 *
 * Web Playwright 与 Desktop CDP 都实现此接口。`evaluate` 接收一段 JS 表达式字符串
 * 在页面上下文求值，确定性检查（白屏/布局/a11y）全部经此跑，规则不在浏览器侧判断、
 * 只取回原始数据。这是 schema 能统一的关键——任何满足 `QaPage` 接口的后端都能驱动
 * 相同的检查规则。
 */
export interface QaPage {
  readonly viewport: QaViewport;
  goto(url: string, timeoutMs?: number): Promise<void>;
  screenshotFullPage(): Promise<Buffer>;
  evaluate<T>(script: string): Promise<T>;
  close(): Promise<void>;
}

/** QA Page 生命周期事件钩子，在 `goto` 期间收集（Web push 模型；Desktop 可用适配器桥接）。 */
export interface QaPageHooks {
  headers?: Record<string, string>;
  storageState?: QaStorageState;
  onConsole?(msg: QaConsoleMessage): void;
  onPageError?(errorText: string): void;
  onResponse?(res: QaNetworkResponse): void;
}

/**
 * QA 单条失败（所有检查种类共用）。
 *
 * `type` 取值：console_error / pageerror / network_http_error / blank /
 * horizontal_overflow / content_invisible / element_overlap / text_truncated /
 * layout_break / a11y_img_alt / a11y_label / a11y_contrast / a11y_tabindex /
 * a11y_landmark / visual_verdict / evaluate_failed / navigation_failed /
 * browser_unavailable / capture_failed 等。
 */
export interface QaFailure {
  type: string;
  viewport?: number;
  detail: string;
  artifactPath?: string | null;
}

/** `qa.check_passed` 事件 payload（plan §4.2）。 */
export type QaCheckPassedPayload = {
  checkId: QaCheckId;
  kind: QaCheckKind;
  viewports: number[];
  durationMs: number;
  artifactPath?: string | null;
  runner?: QaRunner;
};

/** `qa.check_failed` 事件 payload（plan §4.2）。 */
export type QaCheckFailedPayload = {
  checkId: QaCheckId;
  kind: QaCheckKind;
  viewports: number[];
  failures: QaFailure[];
  durationMs: number;
  artifactPath?: string | null;
  runner?: QaRunner;
};

/**
 * 统一确定性检查结果（browser/responsive/a11y 共用）。
 *
 * Web 端 `runBrowserCheckUrl` / `runResponsiveCheckUrl` / `runAccessibilitySmokeUrl`
 * 与未来 Desktop 端等价函数都返回此形状，便于 AI 工具与 Studio 不区分产出者消费。
 */
export interface QaCheckResult {
  ok: boolean;
  kind: QaCheckKind;
  failures: QaFailure[];
  viewports: number[];
  durationMs: number;
  artifactPath?: string | null;
  runner?: QaRunner;
}

/** QA gate 结果（保留 skipped/error 语义）。 */
export interface QaGateResult {
  ok: boolean;
  skipped: boolean;
  kind: "gate";
  failures?: QaFailure[];
  error?: string;
  evidencePath?: string | null;
  durationMs: number;
  runner?: QaRunner;
}

/** 截图结果（单 viewport，无 failures）。 */
export interface QaCaptureResult {
  ok: boolean;
  viewport: number;
  durationMs: number;
  screenshotPath?: string | null;
  error?: string;
  runner?: QaRunner;
}
