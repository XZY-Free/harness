/**
 * V10 Phase 6：DebuggerSession 调度器（纯逻辑）。
 *
 * 同一 WebContents 只能有一个活跃的 DebuggerSession。本调度器管理 attach/detach
 * 生命周期，防止多个模块并发 attach 导致 CDP 冲突。
 *
 * 设计要点：
 * - 纯逻辑，不依赖 electron，可在 vitest 中完整测试
 * - 通过 DebuggerSessionTarget 抽象 webContents.debugger，便于 mock
 * - 引用计数：多个读取模块可共享同一 session，最后一个释放时 detach
 * - attach 失败时清理状态，防止泄漏
 *
 * 安全约束：
 * - 不暴露通用 Runtime.evaluate，仅通过固定命令模板访问 CDP
 * - session 不可重入：同一 tabId 重复 attach 返回已存在 session
 */
import type { TabId, ThreadId } from "./tab-store";

/**
 * CDP 命令执行结果。
 */
export interface CdpResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * DebuggerSession 目标接口（抽象 webContents.debugger）。
 */
export interface DebuggerSessionTarget {
  /** attach CDP debugger */
  attach(): void;
  /** detach CDP debugger */
  detach(): void;
  /** 发送 CDP 命令并等待结果 */
  sendCommand(method: string, params?: unknown): Promise<CdpResult>;
  /** 判断当前是否已 attach */
  isAttached(): boolean;
}

/**
 * 活跃的 DebuggerSession。
 */
interface ActiveSession {
  threadId: ThreadId;
  tabId: TabId;
  target: DebuggerSessionTarget;
  refCount: number;
}

/**
 * DebuggerSession 调度器。
 *
 * 管理每个 tabId 的 DebuggerSession attach/detach 生命周期。
 * 同一 tabId 可被多个调用方 acquire，引用计数管理 detach 时机。
 */
export class DebuggerSessionScheduler {
  private sessions = new Map<string, ActiveSession>();
  private targetFactory: (threadId: ThreadId, tabId: TabId) => DebuggerSessionTarget | null;

  /**
   * @param targetFactory 根据 threadId+tabId 创建 DebuggerSessionTarget。
   *                     返回 null 表示 tab 不存在或无法 attach。
   */
  constructor(targetFactory: (threadId: ThreadId, tabId: TabId) => DebuggerSessionTarget | null) {
    this.targetFactory = targetFactory;
  }

  /**
   * 获取 tab 的 DebuggerSession（引用计数 +1）。
   *
   * 如果 session 不存在，创建并 attach。如果已存在，引用计数递增。
   *
   * @returns session target，失败返回 null
   */
  async acquire(threadId: ThreadId, tabId: TabId): Promise<DebuggerSessionTarget | null> {
    const key = this.key(threadId, tabId);

    const existing = this.sessions.get(key);
    if (existing) {
      existing.refCount += 1;
      return existing.target;
    }

    const target = this.targetFactory(threadId, tabId);
    if (!target) {
      return null;
    }

    // attach（如果尚未 attach）
    if (!target.isAttached()) {
      try {
        target.attach();
      } catch {
        return null;
      }
    }

    this.sessions.set(key, {
      threadId,
      tabId,
      target,
      refCount: 1,
    });

    return target;
  }

  /**
   * 释放 tab 的 DebuggerSession（引用计数 -1）。
   *
   * 引用计数归零时 detach 并清理。
   */
  release(threadId: ThreadId, tabId: TabId): void {
    const key = this.key(threadId, tabId);
    const session = this.sessions.get(key);
    if (!session) {
      return;
    }

    session.refCount -= 1;
    if (session.refCount <= 0) {
      try {
        if (session.target.isAttached()) {
          session.target.detach();
        }
      } catch {
        // detach 失败忽略，session 仍会被清理
      }
      this.sessions.delete(key);
    }
  }

  /**
   * 发送 CDP 命令到指定 tab。
   *
   * 自动 acquire + release session，适合一次性命令。
   */
  async sendCommand(
    threadId: ThreadId,
    tabId: TabId,
    method: string,
    params?: unknown,
  ): Promise<CdpResult> {
    const target = await this.acquire(threadId, tabId);
    if (!target) {
      return { ok: false, error: "tab_not_found" };
    }

    try {
      return await target.sendCommand(method, params);
    } finally {
      this.release(threadId, tabId);
    }
  }

  /**
   * 判断 tab 是否有活跃的 DebuggerSession。
   */
  hasSession(threadId: ThreadId, tabId: TabId): boolean {
    return this.sessions.has(this.key(threadId, tabId));
  }

  /**
   * 获取 tab 的当前引用计数（调试用）。
   */
  getRefCount(threadId: ThreadId, tabId: TabId): number {
    return this.sessions.get(this.key(threadId, tabId))?.refCount ?? 0;
  }

  /**
   * 强制清理所有 session（tab 关闭/Thread 销毁时调用）。
   */
  clearThread(threadId: ThreadId): number {
    let cleared = 0;
    for (const [key, session] of this.sessions) {
      if (session.threadId === threadId) {
        try {
          if (session.target.isAttached()) {
            session.target.detach();
          }
        } catch {
          // 忽略 detach 错误
        }
        this.sessions.delete(key);
        cleared += 1;
      }
    }
    return cleared;
  }

  /**
   * 清理所有 session（应用退出时调用）。
   */
  clearAll(): void {
    for (const [, session] of this.sessions) {
      try {
        if (session.target.isAttached()) {
          session.target.detach();
        }
      } catch {
        // 忽略
      }
    }
    this.sessions.clear();
  }

  private key(threadId: ThreadId, tabId: TabId): string {
    return `${threadId}:${tabId}`;
  }
}
