"use client";

import { apiFetch, apiPath } from "@/lib/api-fetch";
import type { ThreadStatus } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

type ThreadItem = {
  id: string;
  title: string;
  status: ThreadStatus;
  model?: string | null;
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string | null;
  previewUrl?: string | null;
  lastMessagePreview?: string | null;
  lastMessageId?: string | null;
};

/* ── 状态元数据 ─────────────────────────────────────────────── */

const STATUS_META: Record<
  ThreadStatus,
  { label: string; dot: string; text: string; badge?: string }
> = {
  idle: { label: "空闲", dot: "bg-[var(--fg-subtle)]", text: "text-[var(--fg-muted)]" },
  executing: {
    label: "执行中",
    dot: "bg-[var(--primary)] animate-gentle-pulse",
    text: "text-[var(--primary)]",
    badge: "bg-[var(--accent-soft)] text-[var(--primary)]",
  },
  ready_for_review: {
    label: "待审核",
    dot: "bg-[var(--ok)]",
    text: "text-[var(--ok)]",
    badge: "bg-[var(--ok-soft)] text-[var(--ok)]",
  },
  failed: {
    label: "失败",
    dot: "bg-[var(--danger)]",
    text: "text-[var(--danger)]",
    badge: "bg-[var(--danger-soft)] text-[var(--danger)]",
  },
  planning: { label: "规划中", dot: "bg-[var(--fg-subtle)]", text: "text-[var(--fg-muted)]" },
  awaiting_input: { label: "待补充", dot: "bg-[var(--warn)]", text: "text-[var(--warn)]" },
  awaiting_approval: { label: "待审批", dot: "bg-[var(--warn)]", text: "text-[var(--warn)]" },
  verifying: { label: "验证中", dot: "bg-[var(--fg-subtle)]", text: "text-[var(--fg-muted)]" },
  delivering: { label: "交付中", dot: "bg-[var(--primary)]", text: "text-[var(--primary)]" },
  completed: {
    label: "已完成",
    dot: "bg-[var(--ok)]",
    text: "text-[var(--ok)]",
    badge: "bg-[var(--ok-soft)] text-[var(--ok)]",
  },
  cancelled: { label: "已取消", dot: "bg-[var(--fg-subtle)]", text: "text-[var(--fg-muted)]" },
};

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return new Date(dateStr).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function groupThreadsByTime(items: ThreadItem[]): { label: string; items: ThreadItem[] }[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 6 * 86400000;

  const today: ThreadItem[] = [];
  const yesterday: ThreadItem[] = [];
  const week: ThreadItem[] = [];
  const older: ThreadItem[] = [];
  for (const t of items) {
    const ts = new Date(t.updatedAt ?? t.createdAt).getTime();
    if (ts >= todayStart) today.push(t);
    else if (ts >= yesterdayStart) yesterday.push(t);
    else if (ts >= weekStart) week.push(t);
    else older.push(t);
  }
  const buckets: { label: string; items: ThreadItem[] }[] = [
    { label: "今天", items: today },
    { label: "昨天", items: yesterday },
    { label: "本周", items: week },
    { label: "更早", items: older },
  ];
  return buckets.filter((g) => g.items.length > 0);
}

/* ── 主组件 ─────────────────────────────────────────────────── */

export function Sidebar({
  threadId,
  status,
  onNewThread,
  onSelectThread,
  onClose,
}: {
  threadId: string;
  status: ThreadStatus;
  onNewThread?: () => void | Promise<void>;
  onSelectThread?: (threadId: string, status: ThreadStatus) => void;
  onClose?: () => void;
}) {
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [seenMap, setSeenMap] = useState<Record<string, string>>({});
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const COLLAPSED_GROUPS_KEY = "snowharness:collapsed-groups";
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set(["昨天", "本周", "更早"]);
    try {
      const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* fallback */
    }
    return new Set(["昨天", "本周", "更早"]);
  });
  const toggleGroup = useCallback((label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      try {
        window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  const [enterBehavior, setEnterBehavior] = useState<"send" | "newline">(() => {
    if (typeof window === "undefined") return "send";
    return localStorage.getItem("snowharness:enter-behavior") === "newline" ? "newline" : "send";
  });
  useEffect(() => {
    const handler = (e: Event) => {
      const mode = (e as CustomEvent<"send" | "newline">).detail;
      if (mode === "send" || mode === "newline") setEnterBehavior(mode);
    };
    window.addEventListener("snowharness:enter-behavior-change", handler);
    return () => window.removeEventListener("snowharness:enter-behavior-change", handler);
  }, []);
  const toggleEnterBehavior = useCallback(() => {
    setEnterBehavior((prev) => {
      const next = prev === "send" ? "newline" : "send";
      localStorage.setItem("snowharness:enter-behavior", next);
      window.dispatchEvent(new CustomEvent("snowharness:enter-behavior-change", { detail: next }));
      return next;
    });
  }, []);

  // 已读
  useEffect(() => {
    try {
      const raw = localStorage.getItem("snowharness:seen-threads");
      if (raw) setSeenMap(JSON.parse(raw) as Record<string, string>);
    } catch {
      /* noop */
    }
  }, []);
  useEffect(() => {
    if (!threadId) return;
    const cur = threads.find((t) => t.id === threadId);
    const lastSeen = cur?.lastMessageId ?? null;
    setSeenMap((prev) => {
      if (lastSeen && prev[threadId] === lastSeen) return prev;
      const next = lastSeen ? { ...prev, [threadId]: lastSeen } : prev;
      try {
        localStorage.setItem("snowharness:seen-threads", JSON.stringify(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }, [threadId, threads]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await apiFetch("/api/threads?limit=50");
      const json = await res.json();
      if (json.ok) {
        const data = (json.data ?? []) as ThreadItem[];
        setThreads(data);
        setNextCursor(json.nextCursor ?? null);
        const cur = data.find((t) => t.id === threadId);
        if (cur) {
          window.dispatchEvent(
            new CustomEvent("snowharness:thread-title-updated", {
              detail: { threadId: cur.id, title: cur.title },
            }),
          );
        }
      }
    } catch {
      /* noop */
    }
  }, [threadId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch(`/api/threads?limit=50&cursor=${encodeURIComponent(nextCursor)}`);
      const json = await res.json();
      if (json.ok) {
        setThreads((prev) => [...prev, ...(json.data ?? [])]);
        setNextCursor(json.nextCursor ?? null);
      }
    } catch {
      /* noop */
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refreshThreads().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshThreads]);

  // SSE
  useEffect(() => {
    const es = new EventSource(apiPath("/api/threads/stream"));
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as {
          kind?: "status" | "event";
          threadId: string;
          status?: "running" | "done" | "failed" | "cancelled";
        };
        if (data.kind !== "status" || !data.status) return;
        const { threadId: tid, status: st } = data;
        if (st === "running") {
          setThreads((prev) => prev.map((t) => (t.id === tid ? { ...t, status: "executing" } : t)));
          stopPoll();
          pollTimer = setInterval(() => refreshThreads(), 2000);
        } else {
          stopPoll();
          refreshThreads();
        }
      } catch {
        /* noop */
      }
    };
    return () => {
      stopPoll();
      es.close();
    };
  }, [refreshThreads]);

  const handleNew = async () => {
    await onNewThread?.();
    await refreshThreads();
  };

  // 搜索
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = searchQuery.trim();
    const timer = setTimeout(async () => {
      if (!q) {
        refreshThreads();
        return;
      }
      setSearching(true);
      try {
        const res = await apiFetch(`/api/threads?limit=50&search=${encodeURIComponent(q)}`);
        const json = await res.json();
        if (json.ok) {
          setThreads(json.data ?? []);
          setNextCursor(null);
        }
      } catch {
        /* noop */
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, refreshThreads]);

  const filteredThreads = threads;

  // 快捷键
  useEffect(() => {
    const onFocusSearch = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    const onNavigate = (e: Event) => {
      const dir = (e as CustomEvent<"next" | "prev">).detail;
      if (filteredThreads.length === 0) return;
      const curIdx = filteredThreads.findIndex((t) => t.id === threadId);
      const targetIdx =
        dir === "next"
          ? curIdx < 0
            ? 0
            : Math.min(curIdx + 1, filteredThreads.length - 1)
          : curIdx <= 0
            ? 0
            : curIdx - 1;
      const target = filteredThreads[targetIdx];
      if (target && target.id !== threadId) {
        onSelectThread?.(target.id, target.status);
      }
    };
    window.addEventListener("snowharness:focus-search", onFocusSearch);
    window.addEventListener("snowharness:navigate-thread", onNavigate as EventListener);
    return () => {
      window.removeEventListener("snowharness:focus-search", onFocusSearch);
      window.removeEventListener("snowharness:navigate-thread", onNavigate as EventListener);
    };
  }, [filteredThreads, threadId, onSelectThread]);

  // 分组
  const hasSearchQuery = searchQuery.trim().length > 0;
  const pinnedThreads = hasSearchQuery ? [] : filteredThreads.filter((t) => t.pinnedAt);
  const unpinnedThreads = hasSearchQuery
    ? filteredThreads
    : filteredThreads.filter((t) => !t.pinnedAt);
  const timeGroups = groupThreadsByTime(unpinnedThreads);
  const groupedThreads =
    pinnedThreads.length > 0
      ? [{ label: "已置顶", items: pinnedThreads }, ...timeGroups]
      : timeGroups;

  // 操作
  const confirmRename = async (id: string) => {
    const title = renameValue.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    try {
      const res = await apiFetch(`/api/threads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (res.ok) {
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
      }
    } catch {
      /* noop */
    }
    setRenamingId(null);
  };

  const confirmDelete = async (id: string) => {
    try {
      const res = await apiFetch(`/api/threads/${id}`, { method: "DELETE" });
      if (res.ok) {
        setThreads((prev) => prev.filter((t) => t.id !== id));
      }
    } catch {
      /* noop */
    }
    setDeletingId(null);
  };

  const regenerateTitle = async (id: string) => {
    try {
      const res = await apiFetch(`/api/threads/${id}/generate-title`, { method: "POST" });
      const json = await res.json();
      if (json.ok?.data?.title) {
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title: json.data.title } : t)));
      }
    } catch {
      /* noop */
    }
  };

  const togglePin = async (id: string, currentlyPinned: boolean) => {
    try {
      const res = await apiFetch(`/api/threads/${id}/pin`, { method: "PUT" });
      if (res.ok) {
        const json = await res.json();
        setThreads((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  pinnedAt: json.data?.pinned ? new Date().toISOString() : null,
                }
              : t,
          ),
        );
      }
    } catch {
      /* noop */
    }
    void currentlyPinned;
  };

  const exportThread = (id: string, format: "md" | "json") => {
    const a = document.createElement("a");
    a.href = apiPath(`/api/threads/${id}/export?format=${format}`);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  /* ── 渲染 ─────────────────────────────────────────────────── */

  return (
    <aside className="flex h-full w-full shrink-0 flex-col bg-[var(--surface)] border-r border-[var(--border)]">
      {/* ── Header ── */}
      <header className="flex items-center gap-3 px-3.5 py-4 border-b border-[var(--border)]">
        <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--accent-gradient)] shadow-[var(--shadow-sm)]">
          <img src="/AIlogo.png" alt="Logo" width={24} height={16} className="shrink-0" />
        </div>
        <div>
          <div className="font-semibold text-[16px] text-[var(--fg)] tracking-tight">
            Snow<span className="text-[var(--primary)]">Harness</span>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex size-7 items-center justify-center rounded-full text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)] lg:hidden"
            aria-label="关闭会话列表"
          >
            <Icon.close size={14} />
          </button>
        )}
      </header>

      {/* ── 主内容（可滚动） ── */}
      <div className="flex-1 overflow-y-auto px-3 pb-4 pt-3">
        {/* 新建会话 */}
        <button
          type="button"
          onClick={handleNew}
          data-codex-new
          className="group mb-2.5 flex w-full items-center justify-between rounded-[var(--radius)] bg-[var(--accent-gradient)] px-3.5 py-2.5 text-[14px] font-medium text-white shadow-[var(--shadow-sm)] transition-all hover:shadow-[var(--shadow-accent)] hover:scale-[1.01]"
        >
          <span className="flex items-center gap-2.5">
            <Icon.plus size={16} className="text-white" />
            新建会话
          </span>
          <kbd className="rounded bg-white/20 px-1.5 py-0.5 text-[11px] text-white/80">N</kbd>
        </button>

        {/* 搜索 */}
        <div className="relative mb-4">
          <Icon.search
            size={15}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--fg-subtle)]"
          />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话…"
            data-codex-search
            className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] py-2.5 pl-10 pr-10 text-[14px] text-[var(--fg)] outline-none transition-all duration-200 placeholder:text-[var(--fg-subtle)] focus:border-[var(--primary)]/60 focus:shadow-[var(--shadow-sm)]"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-[var(--fg-subtle)] transition hover:bg-[var(--surface-3)] hover:text-[var(--fg)]"
              aria-label="清除搜索"
            >
              <Icon.close size={10} />
            </button>
          ) : (
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--fg-subtle)]">
              ⌘K
            </kbd>
          )}
        </div>

        {/* 会话列表 */}
        <section>
          {loading || searching ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Icon.spinner size={18} className="animate-spin text-[var(--fg-subtle)]" />
              <p className="mt-3 text-[12px] text-[var(--fg-subtle)]">加载中…</p>
            </div>
          ) : filteredThreads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-[var(--surface-2)]">
                <Icon.chat size={18} className="text-[var(--fg-subtle)]" />
              </div>
              <p className="text-[13px] text-[var(--fg-subtle)]">
                {searchQuery.trim() ? "未找到匹配的会话" : "还没有会话"}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {groupedThreads.map((group, groupIdx) => {
                const collapsed = collapsedGroups.has(group.label);
                const isPinned = group.label === "已置顶";
                return (
                  <div key={group.label}>
                    {/* 分组标题 */}
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.label)}
                      className="group flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left transition hover:bg-[var(--surface-2)]/60"
                    >
                      <Icon.chevron
                        size={11}
                        className={`shrink-0 text-[var(--fg-subtle)] transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
                      />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--fg-subtle)]">
                        {group.label}
                      </span>
                      <span className="text-[11px] text-[var(--fg-subtle)] opacity-60">
                        {group.items.length}
                      </span>
                    </button>

                    {/* 线程列表 */}
                    {!collapsed && (
                      <div className="mt-1 space-y-0.5">
                        {group.items.map((t) => {
                          const isActive = t.id === threadId;
                          const meta = STATUS_META[t.status as ThreadStatus] ?? STATUS_META.idle;
                          const isRenaming = renamingId === t.id;
                          const isDeleting = deletingId === t.id;
                          const isUnread =
                            !isActive && t.lastMessageId && seenMap[t.id] !== t.lastMessageId;

                          return (
                            <div key={t.id} className="sidebar-thread-item group relative">
                              {isRenaming ? (
                                <div className="px-2 py-2">
                                  <input
                                    ref={renameInputRef}
                                    type="text"
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.preventDefault();
                                        confirmRename(t.id);
                                      }
                                      if (e.key === "Escape") {
                                        e.preventDefault();
                                        setRenamingId(null);
                                      }
                                    }}
                                    onBlur={() => confirmRename(t.id)}
                                    className="w-full rounded-lg border border-[var(--primary)]/40 bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--fg)] outline-none shadow-[var(--shadow-sm)]"
                                    // biome-ignore lint/a11y/noAutofocus: 重命名输入框需要即时聚焦
                                    autoFocus
                                  />
                                </div>
                              ) : isDeleting ? (
                                <div className="flex items-center gap-2 rounded-[var(--radius)] bg-[var(--danger-soft)] px-3 py-2.5">
                                  <span className="text-[12px] font-medium text-[var(--danger)]">
                                    确认删除？
                                  </span>
                                  <div className="ml-auto flex gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => confirmDelete(t.id)}
                                      className="rounded-md bg-[var(--danger)] px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-90"
                                    >
                                      删除
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDeletingId(null)}
                                      className="rounded-md px-2.5 py-1 text-[11px] text-[var(--fg-muted)] transition hover:text-[var(--fg)]"
                                    >
                                      取消
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  {/* 线程项 */}
                                  <button
                                    type="button"
                                    onClick={() => onSelectThread?.(t.id, t.status)}
                                    data-active={isActive}
                                    className={`flex w-full items-start gap-3 rounded-[var(--radius)] px-3 py-2.5 text-left transition-all duration-200 ${
                                      isActive
                                        ? "bg-[var(--accent-soft)] border-l-3 border-[var(--primary)] pl-2.5"
                                        : "hover:bg-[var(--surface-2)]/60"
                                    }`}
                                  >
                                    {/* 状态点 */}
                                    <div className="mt-[7px] flex shrink-0">
                                      <span
                                        className={`block rounded-full ${meta.dot} ${
                                          t.status === "executing" ? "size-2.5" : "size-2"
                                        }`}
                                      />
                                    </div>

                                    {/* 内容 */}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-start justify-between gap-2">
                                        <span
                                          className={`truncate text-[13px] leading-snug ${
                                            isActive
                                              ? "font-semibold text-[var(--fg)]"
                                              : "font-medium text-[var(--fg)]"
                                          }`}
                                        >
                                          {t.title || "未命名会话"}
                                        </span>
                                        {/* 右侧标记 */}
                                        <div className="flex shrink-0 items-center gap-1.5">
                                          {isUnread && (
                                            <span className="block size-2 rounded-full bg-[var(--primary)] animate-subtle-pulse" />
                                          )}
                                          {t.pinnedAt && (
                                            <Icon.bookmark
                                              size={11}
                                              className="text-[var(--primary)] opacity-60"
                                            />
                                          )}
                                        </div>
                                      </div>

                                      {/* 预览文本 */}
                                      {t.lastMessagePreview && (
                                        <p className="mt-1 truncate text-[11.5px] leading-relaxed text-[var(--fg-subtle)]">
                                          {t.lastMessagePreview}
                                        </p>
                                      )}

                                      {/* 底部信息行 */}
                                      <div className="mt-1.5 flex items-center gap-2">
                                        {meta.badge && (
                                          <span
                                            data-codex-status
                                            className={`inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium ${meta.badge}`}
                                          >
                                            {meta.label}
                                          </span>
                                        )}
                                        <span className="text-[10px] text-[var(--fg-subtle)] opacity-70">
                                          {formatTimeAgo(t.updatedAt ?? t.createdAt)}
                                        </span>
                                      </div>
                                    </div>
                                  </button>

                                  {/* 操作菜单按钮 */}
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setMenuOpenId(menuOpenId === t.id ? null : t.id);
                                    }}
                                    className="absolute right-2 top-2.5 flex size-6 items-center justify-center rounded-md text-[var(--fg-subtle)] opacity-0 transition-all duration-150 hover:bg-[var(--surface-3)] hover:text-[var(--fg)] group-hover:opacity-100"
                                    aria-label="会话操作"
                                  >
                                    <Icon.moreHorizontal size={14} />
                                  </button>

                                  {/* 下拉菜单 */}
                                  {menuOpenId === t.id && (
                                    <>
                                      <div
                                        className="fixed inset-0 z-30"
                                        onClick={() => setMenuOpenId(null)}
                                        onKeyDown={() => setMenuOpenId(null)}
                                      />
                                      <div className="animate-pop absolute right-2 top-9 z-40 w-[160px] overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-pop)]">
                                        <div className="py-1">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setRenamingId(t.id);
                                              setRenameValue(t.title || "");
                                              setMenuOpenId(null);
                                            }}
                                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-[var(--fg)] transition hover:bg-[var(--surface-2)]"
                                          >
                                            <Icon.pencil
                                              size={13}
                                              className="text-[var(--fg-subtle)]"
                                            />
                                            重命名
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              void regenerateTitle(t.id);
                                              setMenuOpenId(null);
                                            }}
                                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-[var(--fg)] transition hover:bg-[var(--surface-2)]"
                                          >
                                            <Icon.refresh
                                              size={13}
                                              className="text-[var(--fg-subtle)]"
                                            />
                                            AI 生成标题
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              void togglePin(t.id, !!t.pinnedAt);
                                              setMenuOpenId(null);
                                            }}
                                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-[var(--fg)] transition hover:bg-[var(--surface-2)]"
                                          >
                                            <Icon.bookmark
                                              size={13}
                                              className="text-[var(--fg-subtle)]"
                                            />
                                            {t.pinnedAt ? "取消置顶" : "置顶会话"}
                                          </button>
                                        </div>
                                        <div className="border-t border-[var(--border)]" />
                                        <div className="py-1">
                                          <button
                                            type="button"
                                            onClick={() => exportThread(t.id, "md")}
                                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-[var(--fg)] transition hover:bg-[var(--surface-2)]"
                                          >
                                            <Icon.download
                                              size={13}
                                              className="text-[var(--fg-subtle)]"
                                            />
                                            导出 Markdown
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => exportThread(t.id, "json")}
                                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-[var(--fg)] transition hover:bg-[var(--surface-2)]"
                                          >
                                            <Icon.fileText
                                              size={13}
                                              className="text-[var(--fg-subtle)]"
                                            />
                                            导出 JSON
                                          </button>
                                        </div>
                                        <div className="border-t border-[var(--border)]" />
                                        <div className="py-1">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setDeletingId(t.id);
                                              setMenuOpenId(null);
                                            }}
                                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-[var(--danger)] transition hover:bg-[var(--danger-soft)]"
                                          >
                                            <Icon.trash size={13} />
                                            删除会话
                                          </button>
                                        </div>
                                      </div>
                                    </>
                                  )}
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* 置顶区分隔 */}
                    {isPinned && <div className="mt-3 mb-2 border-t border-[var(--border)]" />}
                  </div>
                );
              })}

              {/* 加载更多 */}
              {nextCursor && !searchQuery.trim() ? (
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-[var(--radius-sm)] py-2.5 text-[12px] text-[var(--fg-subtle)] transition-all hover:bg-[var(--surface-2)] hover:text-[var(--fg-muted)] disabled:opacity-50"
                >
                  {loadingMore ? (
                    <>
                      <Icon.spinner size={12} className="animate-spin" />
                      加载中…
                    </>
                  ) : (
                    "加载更多"
                  )}
                </button>
              ) : null}
            </div>
          )}
        </section>
      </div>

      {/* ── 底部 ── */}
      <footer className="shrink-0 border-t border-[var(--border)] px-3 py-2.5">
        <div className="flex items-center justify-between">
          <button
            type="button"
            className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[13px] text-[var(--fg-muted)] transition-all hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          >
            <Icon.settings size={15} className="shrink-0 text-[var(--fg-subtle)]" />
            设置
          </button>
          <button
            type="button"
            onClick={toggleEnterBehavior}
            className="flex items-center rounded-md px-2 py-1.5 text-[11px] text-[var(--fg-subtle)] transition-all hover:bg-[var(--surface-2)] hover:text-[var(--fg-muted)]"
            title={
              enterBehavior === "send"
                ? "Enter 发送（点击切换为换行）"
                : "Enter 换行（点击切换为发送）"
            }
          >
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              {enterBehavior === "send" ? "↵ 发送" : "↵ 换行"}
            </kbd>
          </button>
        </div>
      </footer>
    </aside>
  );
}
