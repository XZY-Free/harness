"use client";

/**
 * Sidebar 收起状态上下文（W3-2）。
 *
 * 职责：
 * - 管理侧栏 collapsed 状态。
 * - 监听 ⌘\ 快捷键切换。
 * - 响应式：窗口宽度 <1180px 时自动收起。
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface SidebarContextValue {
  readonly collapsed: boolean;
  /** 是否处于 <1180px 断点（侧栏此时为 overlay drawer）。 */
  readonly isNarrow: boolean;
  readonly toggle: () => void;
  readonly setCollapsed: (v: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({
  children,
  defaultCollapsed = false,
}: {
  readonly children: React.ReactNode;
  readonly defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [isNarrow, setIsNarrow] = useState(false);

  const toggle = useCallback(() => setCollapsed((v) => !v), []);

  // ⌘\ 快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle]);

  // 响应式：窗口 <1180px 自动收起（overlay drawer），≥1180px 恢复为固定侧栏
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1179px)");
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setCollapsed(e.matches);
      setIsNarrow(e.matches);
    };
    onChange(mq);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <SidebarContext.Provider value={{ collapsed, isNarrow, toggle, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
  return ctx;
}

/** 供同时承载 Web / Desktop 变体的页面读取；Web 端没有侧栏时返回 null。 */
export function useOptionalSidebar(): SidebarContextValue | null {
  return useContext(SidebarContext);
}
