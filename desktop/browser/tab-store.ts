/**
 * V10 Phase 4：Browser tab 内存状态管理。
 *
 * 纯逻辑模块，不依赖 electron。管理 Thread 级 tab 分组、active tab、
 * new/close/switch/reorder 操作。WebContentsView 生命周期由 BrowserController 管理。
 */

export type TabId = string;
export type ThreadId = string;

/** Tab 加载状态 */
export type TabLoadState = "idle" | "loading" | "loaded" | "crashed" | "error";

/** Tab 元数据（不包含 WebContentsView 引用，纯数据可序列化） */
export interface TabMetadata {
  id: TabId;
  threadId: ThreadId;
  url: string;
  title: string;
  favicon: string | null;
  loadState: TabLoadState;
  canGoBack: boolean;
  canGoForward: boolean;
  incognito: boolean;
  createdAt: number;
  updatedAt: number;
  /** 错误信息（loadState 为 error/crashed 时填充） */
  error: string | null;
}

/** Thread 的 tab 分组状态 */
export interface ThreadTabState {
  threadId: ThreadId;
  tabs: Map<TabId, TabMetadata>;
  activeTabId: TabId | null;
  tabOrder: TabId[];
}

/** Tab store 事件类型 */
export type TabStoreEvent =
  | { type: "tab-created"; tab: TabMetadata }
  | { type: "tab-closed"; tabId: TabId; threadId: ThreadId }
  | { type: "tab-updated"; tab: TabMetadata }
  | { type: "active-tab-changed"; threadId: ThreadId; activeTabId: TabId | null }
  | { type: "tab-reordered"; threadId: ThreadId; tabOrder: TabId[] };

/** 生成唯一 tab ID（使用 nanoid 格式） */
export function generateTabId(): string {
  // 使用 timestamp + random 生成，测试中可 mock
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * TabStore - 管理 Thread 级 tab 状态。
 *
 * 纯逻辑，不持有 WebContentsView 引用。BrowserController 负责将
 * WebContentsView 与 tab ID 关联。
 */
export class TabStore {
  private threads = new Map<ThreadId, ThreadTabState>();
  private listeners = new Set<(event: TabStoreEvent) => void>();

  /** 订阅 tab 变更事件 */
  subscribe(listener: (event: TabStoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: TabStoreEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** 获取或创建 Thread 的 tab 状态 */
  private getOrCreateThread(threadId: ThreadId): ThreadTabState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = { threadId, tabs: new Map(), activeTabId: null, tabOrder: [] };
      this.threads.set(threadId, state);
    }
    return state;
  }

  /** 获取 Thread 的 tab 状态（不存在返回 null） */
  getThreadState(threadId: ThreadId): ThreadTabState | null {
    return this.threads.get(threadId) ?? null;
  }

  /** 获取 Thread 中所有 tabs（按顺序） */
  getTabs(threadId: ThreadId): TabMetadata[] {
    const state = this.threads.get(threadId);
    if (!state) return [];
    return state.tabOrder
      .map((id) => state.tabs.get(id))
      .filter((t): t is TabMetadata => t !== undefined);
  }

  /** 获取单个 tab */
  getTab(threadId: ThreadId, tabId: TabId): TabMetadata | null {
    return this.threads.get(threadId)?.tabs.get(tabId) ?? null;
  }

  /** 获取 active tab */
  getActiveTab(threadId: ThreadId): TabMetadata | null {
    const state = this.threads.get(threadId);
    if (!state || !state.activeTabId) return null;
    return state.tabs.get(state.activeTabId) ?? null;
  }

  /** 创建新 tab */
  createTab(
    threadId: ThreadId,
    url: string,
    opts?: { incognito?: boolean; tabId?: string; activate?: boolean },
  ): TabMetadata {
    const state = this.getOrCreateThread(threadId);
    const tabId = opts?.tabId ?? generateTabId();
    const now = Date.now();
    const tab: TabMetadata = {
      id: tabId,
      threadId,
      url,
      title: "",
      favicon: null,
      loadState: "idle",
      canGoBack: false,
      canGoForward: false,
      incognito: opts?.incognito ?? false,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    state.tabs.set(tabId, tab);
    state.tabOrder.push(tabId);
    if (opts?.activate !== false) {
      state.activeTabId = tabId;
    }
    this.emit({ type: "tab-created", tab });
    if (opts?.activate !== false) {
      this.emit({ type: "active-tab-changed", threadId, activeTabId: tabId });
    }
    return tab;
  }

  /** 关闭 tab。如果关闭的是 active tab，自动切换到相邻 tab。 */
  closeTab(threadId: ThreadId, tabId: TabId): TabMetadata | null {
    const state = this.threads.get(threadId);
    if (!state) return null;
    const tab = state.tabs.get(tabId);
    if (!tab) return null;

    state.tabs.delete(tabId);
    const orderIdx = state.tabOrder.indexOf(tabId);
    if (orderIdx >= 0) {
      state.tabOrder.splice(orderIdx, 1);
    }

    // 如果关闭的是 active tab，自动切换
    if (state.activeTabId === tabId) {
      if (state.tabOrder.length === 0) {
        state.activeTabId = null;
      } else {
        // 切换到相邻 tab（优先右侧，否则左侧）
        const newIdx = Math.min(orderIdx, state.tabOrder.length - 1);
        state.activeTabId = state.tabOrder[newIdx] ?? null;
      }
      this.emit({ type: "active-tab-changed", threadId, activeTabId: state.activeTabId });
    }

    this.emit({ type: "tab-closed", tabId, threadId });
    return tab;
  }

  /** 切换 active tab */
  setActiveTab(threadId: ThreadId, tabId: TabId): boolean {
    const state = this.threads.get(threadId);
    if (!state || !state.tabs.has(tabId)) return false;
    if (state.activeTabId === tabId) return true;
    state.activeTabId = tabId;
    this.emit({ type: "active-tab-changed", threadId, activeTabId: tabId });
    return true;
  }

  /** 更新 tab 元数据（部分更新） */
  updateTab(
    threadId: ThreadId,
    tabId: TabId,
    updates: Partial<Omit<TabMetadata, "id" | "threadId" | "createdAt">>,
  ): TabMetadata | null {
    const state = this.threads.get(threadId);
    if (!state) return null;
    const tab = state.tabs.get(tabId);
    if (!tab) return null;
    const updated: TabMetadata = {
      ...tab,
      ...updates,
      id: tab.id,
      threadId: tab.threadId,
      createdAt: tab.createdAt,
      updatedAt: Date.now(),
    };
    state.tabs.set(tabId, updated);
    this.emit({ type: "tab-updated", tab: updated });
    return updated;
  }

  /** 重排 tabs（拖拽排序） */
  reorderTabs(threadId: ThreadId, newOrder: TabId[]): boolean {
    const state = this.threads.get(threadId);
    if (!state) return false;
    // 校验：newOrder 必须包含所有现有 tab，不多不少
    const currentSet = new Set(state.tabs.keys());
    const newSet = new Set(newOrder);
    if (currentSet.size !== newSet.size) return false;
    for (const id of currentSet) {
      if (!newSet.has(id)) return false;
    }
    state.tabOrder = [...newOrder];
    this.emit({ type: "tab-reordered", threadId, tabOrder: state.tabOrder });
    return true;
  }

  /** 关闭 Thread 的所有 tabs（Thread 删除时调用） */
  closeAllTabs(threadId: ThreadId): number {
    const state = this.threads.get(threadId);
    if (!state) return 0;
    const count = state.tabs.size;
    const tabIds = [...state.tabOrder];
    for (const tabId of tabIds) {
      this.closeTab(threadId, tabId);
    }
    this.threads.delete(threadId);
    return count;
  }

  /** 获取所有 Thread ID（用于恢复或清理） */
  getThreadIds(): ThreadId[] {
    return [...this.threads.keys()];
  }

  /** 获取 Thread 的 tab 数量 */
  getTabCount(threadId: ThreadId): number {
    return this.threads.get(threadId)?.tabs.size ?? 0;
  }
}
