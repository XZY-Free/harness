/**
 * V10 Phase 7-4：隐藏 QA WebContents 控制器。
 *
 * 管理 Desktop 端 AI QA 专用的隐藏 WebContents：
 * - 每个 thread 一个独立的隐藏 BrowserWindow（show: false，不可见）
 * - 使用临时 Session partition（与用户 tab 隔离，不共享 Cookie/缓存）
 * - 强制 read-only 策略（下载/弹窗/权限/外部协议/证书错误全部拒绝）
 * - 导航只允许 http/https（阻止 file:/data:/javascript:）
 * - 注入 read-only 脚本阻止表单提交和 window.open
 *
 * 与 BrowserController 的区别：
 * - BrowserController 管理用户可见的 tab（WebContentsView attached to BrowserWindow）
 * - QaController 管理不可见的 QA 专用 WebContents（hidden BrowserWindow）
 * - QA 不复用用户 tab，不影响用户 URL/滚动/表单/下载
 *
 * CDP 集成（Phase 7-5 扩展）：
 * - 复用 PageInsightsStore 缓冲 console/network 事件
 * - 通过 debugger attach Runtime+Network 域捕获事件
 * - evaluate/screenshot 通过 CDP 命令实现
 */

import type { QaPage, QaViewport } from "../../lib/desktop/qa-schema";
import type { PageInsightsStore } from "../browser/page-insights-store";
import {
  QA_READONLY_INJECTION,
  decideQaCertificateError,
  decideQaDownload,
  decideQaExternalProtocol,
  decideQaNavigation,
  decideQaPermission,
  decideQaPopup,
  isReadOnlyRequestMethod,
} from "./qa-policy";

/**
 * V10 Phase 7-5：QaViewport / QaPage 类型从 `lib/desktop/qa-schema` 统一导入，
 * 与 Web 端 Playwright QA 共用同一形状。re-export 便于桌面内部模块从
 * `desktop/qa/qa-controller` 路径继续导入。
 */
export type { QaPage, QaViewport } from "../../lib/desktop/qa-schema";

/**
 * QA WebContents 工厂接口（注入点，便于测试 mock）。
 *
 * 生产实现使用 Electron BrowserWindow + WebContents + Session；
 * 测试实现返回 mock 对象验证调用。
 */
export interface QaWebContentsFactory {
  /** 创建隐藏 BrowserWindow 并返回其 webContents 句柄。 */
  createHiddenWebContents(threadId: string, viewport: QaViewport): QaWebContentsHandle;
}

/** QA WebContents 句柄（工厂创建，控制器消费）。 */
export interface QaWebContentsHandle {
  /** webContents ID（用于索引）。 */
  readonly id: number;
  /** 导航到 URL。 */
  loadURL(url: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** 执行 JS 表达式。 */
  executeJavaScript<T>(script: string): Promise<T>;
  /** 全页截图。 */
  capturePage(): Promise<Buffer>;
  /** 设置 viewport。 */
  setViewport(viewport: QaViewport): void;
  /** 注册 did-finish-load 回调。 */
  onDidFinishLoad(callback: () => void): void;
  /** 注册 will-navigate 回调（返回 false 阻止导航）。 */
  onWillNavigate(callback: (url: string) => boolean): void;
  /** 销毁隐藏窗口。 */
  destroy(): void;
  /** 附加 read-only 策略（注册 session 事件处理器）。 */
  applyReadOnlyPolicy(): void;
}

/**
 * QA WebContents 控制器。
 *
 * 每个 thread 最多一个隐藏 QA WebContents，按需创建，closeQa/closeThread 时销毁。
 */
export class QaController {
  /** threadId → QA handle */
  private readonly qaHandles = new Map<string, QaWebContentsHandle>();
  /** threadId → PageInsightsStore（复用 Phase 7-3 的缓冲存储） */
  private readonly pageInsightsStore: PageInsightsStore;

  constructor(
    pageInsightsStore: PageInsightsStore,
    private readonly factory: QaWebContentsFactory,
  ) {
    this.pageInsightsStore = pageInsightsStore;
  }

  /**
   * 为 thread 创建隐藏 QA WebContents 并导航到 URL。
   *
   * 如果该 thread 已有 QA WebContents，先关闭再重建（确保 viewport 正确）。
   * 策略：read-only（下载/弹窗/权限/外部协议/证书错误全部拒绝）。
   *
   * @returns QaPage 句柄，或 null 表示创建失败
   */
  openQaPage(threadId: string, url: string, viewport: QaViewport): QaPage | null {
    // 导航策略校验：只允许 http/https
    if (decideQaNavigation(url) !== "allow") {
      return null;
    }

    // 如果已有 QA WebContents，先关闭
    if (this.qaHandles.has(threadId)) {
      this.closeQa(threadId);
    }

    // 通过工厂创建隐藏 WebContents
    const handle = this.factory.createHiddenWebContents(threadId, viewport);
    handle.applyReadOnlyPolicy();

    // 注册 did-finish-load 回调注入 read-only 脚本
    handle.onDidFinishLoad(() => {
      handle.executeJavaScript(QA_READONLY_INJECTION).catch(() => {
        // 注入失败不阻断 QA（页面可能已导航）
      });
    });

    // 注册 will-navigate 回调：阻止非 http/https 导航
    handle.onWillNavigate((targetUrl: string) => {
      return decideQaNavigation(targetUrl) === "allow";
    });

    this.qaHandles.set(threadId, handle);

    // 返回 QaPage 句柄
    return {
      viewport,
      goto: async (targetUrl: string, timeoutMs?: number) => {
        if (decideQaNavigation(targetUrl) !== "allow") {
          throw new Error(`QA 导航被阻止（非 http/https）：${targetUrl}`);
        }
        await handle.loadURL(targetUrl, { timeoutMs });
      },
      screenshotFullPage: async () => {
        return handle.capturePage();
      },
      evaluate: async <T>(script: string): Promise<T> => {
        return handle.executeJavaScript<T>(script);
      },
      close: async () => {
        this.closeQa(threadId);
      },
    };
  }

  /**
   * 关闭 thread 的 QA WebContents。
   *
   * 清理隐藏窗口 + PageInsightsStore 中该 thread 的缓冲。
   */
  closeQa(threadId: string): void {
    const handle = this.qaHandles.get(threadId);
    if (handle) {
      handle.destroy();
      this.qaHandles.delete(threadId);
    }
    // 清理 PageInsightsStore 中该 thread 的所有缓冲
    // 使用一个固定 tabId "qa" 标识 QA 缓冲
    this.pageInsightsStore.clearTab(threadId, "qa");
  }

  /**
   * 关闭 thread 的所有 QA 资源（thread 销毁时调用）。
   */
  closeThread(threadId: string): void {
    this.closeQa(threadId);
    // PageInsightsStore.clearThread 清理该 thread 的所有 tab 缓冲
    this.pageInsightsStore.clearThread(threadId);
  }

  /**
   * 检查 thread 是否有活跃的 QA WebContents。
   */
  hasQaPage(threadId: string): boolean {
    return this.qaHandles.has(threadId);
  }
}

/**
 * 应用 read-only 策略到 QA Session。
 *
 * 在 QaWebContentsFactory 的生产实现中调用，注册：
 * - session.on('will-download') → preventDefault
 * - session.setPermissionRequestHandler → deny all
 * - session.setPermissionCheckHandler → deny all
 * - wc.setWindowOpenHandler → deny
 * - wc.session.webRequest.onBeforeRequest → 阻断 POST/PUT/DELETE/PATCH
 *
 * 本函数仅导出策略决策逻辑，Electron 事件注册在生产工厂实现中完成。
 */
export const QA_POLICY_DECISIONS = {
  decideQaDownload,
  decideQaPermission,
  decideQaPopup,
  decideQaExternalProtocol,
  decideQaCertificateError,
  decideQaNavigation,
  isReadOnlyRequestMethod,
} as const;
