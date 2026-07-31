/**
 * V10 Phase 6：Electron WebContents Debugger 适配器。
 *
 * 包装 Electron 的 `webContents.debugger` API，实现纯逻辑的
 * DebuggerSessionTarget 接口，使其可在 DebuggerSessionScheduler 中使用。
 *
 * Electron webContents.debugger API 约定：
 * - `debugger.attach(protocolVersion?: string)` —— 附加调试器（默认 '1.3'）
 * - `debugger.isAttached()` —— 返回 boolean，判断是否已附加
 * - `debugger.sendCommand(method, params?)` —— Promise<{result: ...}>，失败时 reject
 * - `debugger.detach()` —— 分离调试器
 *
 * 设计要点：
 * - 不持有任何状态，所有状态由 webContents.debugger 维护
 * - attach/detach 不抛错（吞掉异常，调用方通过 isAttached 判断真实状态）
 * - sendCommand 不抛错，失败时返回 { ok: false, error }
 */
import type { WebContents } from "electron";
import type { CdpResult, DebuggerSessionTarget } from "./debugger-session-scheduler";

/** CDP 协议版本（Electron 默认值） */
const CDP_PROTOCOL_VERSION = "1.3";

/**
 * WebContentsDebuggerTarget —— Electron webContents.debugger 的适配器。
 *
 * 实现 DebuggerSessionTarget 接口，将 Electron 的 debugger API
 * 转换为调度器期望的 Promise + CdpResult 形式。
 */
export class WebContentsDebuggerTarget implements DebuggerSessionTarget {
  private readonly webContents: WebContents;

  constructor(webContents: WebContents) {
    this.webContents = webContents;
  }

  /**
   * 附加 CDP 调试器（protocolVersion '1.3'）。
   *
   * 如果已附加或其他原因导致 attach 抛错，吞掉异常，
   * 由调用方通过 isAttached() 判断真实状态。
   */
  attach(): void {
    try {
      this.webContents.debugger.attach(CDP_PROTOCOL_VERSION);
    } catch {
      // 已附加或 attach 失败：吞掉异常，调用方通过 isAttached 判断
    }
  }

  /**
   * 分离 CDP 调试器。
   *
   * detach 失败时静默忽略（可能本来就没有 attach）。
   */
  detach(): void {
    try {
      this.webContents.debugger.detach();
    } catch {
      // detach 失败忽略
    }
  }

  /**
   * 判断当前是否已附加调试器。
   *
   * 调用 Electron 的 `webContents.debugger.isAttached()` 方法获取状态。
   */
  isAttached(): boolean {
    return this.webContents.debugger.isAttached();
  }

  /**
   * 发送 CDP 命令并等待结果。
   *
   * 成功时返回 { ok: true, result }，失败时返回 { ok: false, error }。
   * 不抛出异常。
   */
  async sendCommand(method: string, params?: unknown): Promise<CdpResult> {
    try {
      const response = await this.webContents.debugger.sendCommand(method, params);
      // Electron 返回 { result: ... }，部分命令返回其他结构
      const result =
        response && typeof response === "object" && "result" in response
          ? (response as { result: unknown }).result
          : response;
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
