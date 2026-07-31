/**
 * V10 Phase 4：View 注册表。
 *
 * 纯逻辑模块，管理 tabId 到 WebContentsView 引用的映射。
 * 处理 active tab 切换时的显示/隐藏逻辑。
 *
 * 不依赖 electron，可在 vitest 中测试。
 * WebContentsView 实例通过泛型参数注入，避免直接 import electron。
 */

export type TabId = string;
export type ThreadId = string;

/**
 * View 注册表。
 *
 * 管理 threadId+tabId → view 的映射。
 * 同一 Thread 只有一个 active view 可见，其他隐藏。
 */
export class ViewRegistry<V> {
  /** threadId → (tabId → view) */
  private views = new Map<ThreadId, Map<TabId, V>>();
  /** 每个 Thread 的 active view（可见的 view） */
  private activeViews = new Map<ThreadId, TabId>();

  /**
   * 注册 view。
   * @param threadId - Thread ID
   * @param tabId - Tab ID
   * @param view - View 实例
   * @param activate - 是否设为 active（默认 true）
   */
  set(threadId: ThreadId, tabId: TabId, view: V, activate = true): void {
    let threadViews = this.views.get(threadId);
    if (!threadViews) {
      threadViews = new Map();
      this.views.set(threadId, threadViews);
    }
    threadViews.set(tabId, view);
    if (activate) {
      this.setActive(threadId, tabId);
    }
  }

  /** 获取 view */
  get(threadId: ThreadId, tabId: TabId): V | undefined {
    return this.views.get(threadId)?.get(tabId);
  }

  /** 删除 view（返回被删除的 view） */
  delete(threadId: ThreadId, tabId: TabId): V | undefined {
    const threadViews = this.views.get(threadId);
    if (!threadViews) return undefined;
    const view = threadViews.get(tabId);
    threadViews.delete(tabId);
    // 如果删除的是 active view，清除 active 标记
    if (this.activeViews.get(threadId) === tabId) {
      this.activeViews.delete(threadId);
    }
    // 如果 Thread 没有更多 view，清理
    if (threadViews.size === 0) {
      this.views.delete(threadId);
      this.activeViews.delete(threadId);
    }
    return view;
  }

  /** 设置 active view（可见的 view） */
  setActive(threadId: ThreadId, tabId: TabId): boolean {
    const threadViews = this.views.get(threadId);
    if (!threadViews || !threadViews.has(tabId)) return false;
    this.activeViews.set(threadId, tabId);
    return true;
  }

  /** 获取 active view 的 tabId */
  getActiveTabId(threadId: ThreadId): TabId | undefined {
    return this.activeViews.get(threadId);
  }

  /** 获取 active view */
  getActiveView(threadId: ThreadId): V | undefined {
    const tabId = this.activeViews.get(threadId);
    if (!tabId) return undefined;
    return this.views.get(threadId)?.get(tabId);
  }

  /** 获取 Thread 的所有 view tabId 列表 */
  getViewIds(threadId: ThreadId): TabId[] {
    const threadViews = this.views.get(threadId);
    if (!threadViews) return [];
    return [...threadViews.keys()];
  }

  /** 获取 Thread 的 view 数量 */
  getCount(threadId: ThreadId): number {
    return this.views.get(threadId)?.size ?? 0;
  }

  /** 判断 view 是否为 active */
  isActive(threadId: ThreadId, tabId: TabId): boolean {
    return this.activeViews.get(threadId) === tabId;
  }

  /**
   * 获取需要显示和隐藏的 view 变更。
   * 切换 active tab 时调用：返回新 active view 和需要隐藏的旧 active view。
   */
  getActivationChange(threadId: ThreadId, newTabId: TabId): { show?: V; hide?: V } | null {
    const threadViews = this.views.get(threadId);
    if (!threadViews || !threadViews.has(newTabId)) return null;
    const oldActiveTabId = this.activeViews.get(threadId);
    const show = threadViews.get(newTabId);
    const hide =
      oldActiveTabId !== undefined && oldActiveTabId !== newTabId
        ? threadViews.get(oldActiveTabId)
        : undefined;
    return { show, hide };
  }

  /** 清除 Thread 的所有 view（返回所有 view 供销毁） */
  clearThread(threadId: ThreadId): V[] {
    const threadViews = this.views.get(threadId);
    if (!threadViews) return [];
    const views = [...threadViews.values()];
    this.views.delete(threadId);
    this.activeViews.delete(threadId);
    return views;
  }

  /** 获取所有有 view 的 Thread ID */
  getThreadIds(): ThreadId[] {
    return [...this.views.keys()];
  }
}
