"use client";

import { Icon } from "@/components/icons";
import {
  type DesktopBrowserStateUpdate,
  type DesktopTabMetadata,
  getDesktopBridge,
} from "@/lib/desktop/capabilities";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface DesktopBrowserSurfaceProps {
  threadId: string;
  userId: string;
  initialUrl: string | null;
  /** 工作台调整宽度时临时隐藏 native view，避免截获分隔线的指针事件。 */
  suspendNativeView?: boolean;
}

function resolveInitialUrl(url: string | null, serverOrigin: string): string {
  if (!url) return "";
  try {
    return new URL(url, serverOrigin).toString();
  } catch {
    return "";
  }
}

export function DesktopBrowserSurface({
  threadId,
  userId,
  initialUrl,
  suspendNativeView = false,
}: DesktopBrowserSurfaceProps) {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const [tabs, setTabs] = useState<DesktopTabMetadata[]>([]);
  const [activeTab, setActiveTab] = useState<DesktopTabMetadata | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aiLocked, setAiLocked] = useState(false);
  const [cancellingAi, setCancellingAi] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const draggedTabIdRef = useRef<string | null>(null);

  const applyState = useCallback(
    (nextTabs: DesktopTabMetadata[], nextActive: DesktopTabMetadata | null) => {
      setTabs(nextTabs);
      setActiveTab(nextActive);
      if (nextActive) setAddress(nextActive.url);
    },
    [],
  );

  const refreshState = useCallback(async () => {
    if (!bridge) return;
    const [nextTabs, nextActive] = await Promise.all([
      bridge.browser.getTabs(threadId),
      bridge.browser.getActiveTab(threadId),
    ]);
    applyState(nextTabs, nextActive);
  }, [applyState, bridge, threadId]);

  useEffect(() => {
    if (!bridge) {
      setError("Desktop Browser Bridge 不可用");
      return;
    }
    let cancelled = false;
    const stop = bridge.browser.onTabUpdate((update: DesktopBrowserStateUpdate) => {
      if (!cancelled && update.threadId === threadId) {
        applyState(update.tabs, update.activeTab);
      }
    });
    const stopLock = bridge.browser.onLockStateChange((update) => {
      if (update.threadId === threadId) {
        setAiLocked(update.locked);
        if (!update.locked) setCancellingAi(false);
      }
    });

    const initialize = async () => {
      try {
        await bridge.browser.subscribe(threadId);
        setAiLocked(await bridge.browser.getLockState(threadId));
        await bridge.browser.restoreTabs(threadId, userId);
        let nextTabs = await bridge.browser.getTabs(threadId);
        if (nextTabs.length === 0) {
          const url = resolveInitialUrl(initialUrl, bridge.capabilities.serverOrigin);
          await bridge.browser.createTab(threadId, url, userId, { activate: true });
          nextTabs = await bridge.browser.getTabs(threadId);
        }
        const nextActive = await bridge.browser.getActiveTab(threadId);
        if (!cancelled) applyState(nextTabs, nextActive);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "浏览器初始化失败");
      }
    };
    void initialize();

    return () => {
      cancelled = true;
      stop();
      stopLock();
      void bridge.browser.hideViews(threadId);
    };
  }, [applyState, bridge, initialUrl, threadId, userId]);

  const takeOver = useCallback(async () => {
    if (!bridge || cancellingAi) return;
    setCancellingAi(true);
    const requested = await bridge.browser.cancelAi(threadId);
    if (!requested) {
      setCancellingAi(false);
      setError("当前无法停止 AI，请等待连接恢复");
    }
  }, [bridge, cancellingAi, threadId]);

  useEffect(() => {
    if (!bridge || !suspendNativeView) return;
    void bridge.browser.hideViews(threadId);
  }, [bridge, suspendNativeView, threadId]);

  useEffect(() => {
    if (!bridge || !activeTab || suspendNativeView) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateBounds = () => {
      const rect = viewport.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void bridge.browser.setBounds(
        threadId,
        activeTab.id,
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        window.devicePixelRatio,
      );
    };

    const observer = new ResizeObserver(updateBounds);
    observer.observe(viewport);
    window.addEventListener("resize", updateBounds);
    updateBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [activeTab, bridge, suspendNativeView, threadId]);

  const createTab = useCallback(
    async (incognito = false) => {
      if (!bridge) return;
      await bridge.browser.createTab(threadId, "", userId, { activate: true, incognito });
      await refreshState();
      requestAnimationFrame(() => addressRef.current?.focus());
    },
    [bridge, refreshState, threadId, userId],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      if (!bridge) return;
      await bridge.browser.closeTab(threadId, tabId);
      await refreshState();
    },
    [bridge, refreshState, threadId],
  );

  const switchTab = useCallback(
    async (tabId: string) => {
      if (!bridge) return;
      await bridge.browser.switchTab(threadId, tabId);
      await refreshState();
    },
    [bridge, refreshState, threadId],
  );

  const reorderTabs = useCallback(
    async (targetTabId: string) => {
      if (!bridge) return;
      const sourceTabId = draggedTabIdRef.current;
      draggedTabIdRef.current = null;
      if (!sourceTabId || sourceTabId === targetTabId) return;
      const targetIndex = tabs.findIndex((tab) => tab.id === targetTabId);
      const nextOrder = tabs.map((tab) => tab.id).filter((tabId) => tabId !== sourceTabId);
      if (targetIndex < 0 || nextOrder.length === tabs.length) return;
      nextOrder.splice(targetIndex, 0, sourceTabId);
      if (await bridge.browser.reorderTabs(threadId, nextOrder)) {
        await refreshState();
      }
    },
    [bridge, refreshState, tabs, threadId],
  );

  const navigate = useCallback(
    async (type: "back" | "forward" | "reload" | "stop" | "navigate", url?: string) => {
      if (!bridge || !activeTab) return;
      const action = { type, threadId, tabId: activeTab.id, ...(url ? { url } : {}) };
      const ok = await bridge.browser.navigate(threadId, activeTab.id, action);
      if (!ok) setError("导航请求被拒绝");
    },
    [activeTab, bridge, threadId],
  );

  const submitAddress = useCallback(() => {
    const value = address.trim();
    if (!value) return;
    const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    setAddress(normalized);
    void navigate("navigate", normalized);
  }, [address, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "l") {
        event.preventDefault();
        addressRef.current?.focus();
        addressRef.current?.select();
      } else if (key === "r") {
        event.preventDefault();
        void navigate("reload");
      } else if (key === "t") {
        event.preventDefault();
        void createTab(false);
      } else if (key === "w" && activeTab) {
        event.preventDefault();
        void closeTab(activeTab.id);
      } else if (key === "n" && event.shiftKey) {
        event.preventDefault();
        void createTab(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, closeTab, createTab, navigate]);

  if (!bridge) {
    return <BrowserError message={error ?? "请在 SnowHarness Desktop 中打开"} />;
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-[var(--surface)]"
      data-testid="desktop-browser-surface"
    >
      <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface-2)] px-2 pt-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onDragOver={(event) => {
              if (draggedTabIdRef.current && draggedTabIdRef.current !== tab.id) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              void reorderTabs(tab.id);
            }}
            className={`flex h-8 min-w-[120px] max-w-[220px] items-center gap-2 border border-b-0 px-2 text-[12px] ${
              activeTab?.id === tab.id
                ? "border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]"
                : "border-transparent text-[var(--fg-muted)] hover:bg-[var(--surface-3)]"
            }`}
          >
            <button
              type="button"
              draggable={!aiLocked}
              onDragStart={(event) => {
                draggedTabIdRef.current = tab.id;
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                draggedTabIdRef.current = null;
              }}
              onClick={() => void switchTab(tab.id)}
              className="min-w-0 flex-1 truncate text-left"
              title={tab.title || tab.url || "新标签页"}
            >
              {tab.incognito ? "隐身 · " : ""}
              {tab.title || tab.url || "新标签页"}
            </button>
            <button
              type="button"
              onClick={() => void closeTab(tab.id)}
              className="flex size-5 shrink-0 items-center justify-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
              aria-label={`关闭 ${tab.title || "标签页"}`}
            >
              <Icon.close size={11} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => void createTab(false)}
          className="mb-1 flex size-7 shrink-0 items-center justify-center text-[var(--fg-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--fg)]"
          title="新建标签页"
          aria-label="新建标签页"
        >
          <Icon.plus size={14} />
        </button>
      </div>

      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--border)] bg-[var(--surface)] px-2">
        <ToolbarButton
          label="后退"
          disabled={!activeTab?.canGoBack}
          onClick={() => void navigate("back")}
        >
          <Icon.chevron size={14} className="rotate-90" />
        </ToolbarButton>
        <ToolbarButton
          label="前进"
          disabled={!activeTab?.canGoForward}
          onClick={() => void navigate("forward")}
        >
          <Icon.chevron size={14} className="-rotate-90" />
        </ToolbarButton>
        <ToolbarButton
          label="刷新"
          onClick={() => void navigate(activeTab?.loadState === "loading" ? "stop" : "reload")}
        >
          {activeTab?.loadState === "loading" ? (
            <Icon.stop size={11} />
          ) : (
            <Icon.refresh size={14} />
          )}
        </ToolbarButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            submitAddress();
          }}
        >
          <input
            ref={addressRef}
            aria-label="地址"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitAddress();
              }
            }}
            className="h-7 w-full border border-[var(--border)] bg-[var(--surface-2)] px-3 text-[12px] outline-none focus:border-[var(--border-strong)]"
            spellCheck={false}
          />
        </form>
      </div>

      {aiLocked ? (
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface-2)] px-3 text-[12px] text-[var(--fg)]">
          <span>{cancellingAi ? "正在停止 AI..." : "AI 正在操作，页面输入已锁定"}</span>
          <button
            type="button"
            disabled={cancellingAi}
            onClick={() => void takeOver()}
            className="h-7 border border-[var(--border-strong)] px-3 text-[12px] disabled:opacity-50"
          >
            停止并接管
          </button>
        </div>
      ) : null}
      {error ? (
        <output className="shrink-0 border-b border-[var(--danger)] px-3 py-2 text-[12px] text-[var(--danger)]">
          {error}
        </output>
      ) : null}
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 bg-white"
        data-testid="desktop-browser-viewport"
      />
    </div>
  );
}

function ToolbarButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function BrowserError({ message }: { message: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--surface)] px-6 text-center text-[13px] text-[var(--danger)]">
      {message}
    </div>
  );
}
