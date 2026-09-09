"use client";

/**
 * Sidebar 收起状态上下文（W3-2）。
 *
 * 职责：
 * - 管理侧栏 collapsed 状态。
 * - 监听 ⌘\ 快捷键切换。
 * - 响应式：窗口宽度低于 84.9375rem 时自动收起。
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface SidebarContextValue {
  readonly collapsed: boolean;
  /** 是否处于窄屏断点（侧栏此时为 overlay drawer）。 */
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

  // 响应式：窄屏自动收起为 overlay drawer，宽屏恢复为固定侧栏。
  // 断点只决定布局模式；侧栏与对话轨道的实际尺寸由流式 CSS 变量连续计算。
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 84.9375rem)");
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
