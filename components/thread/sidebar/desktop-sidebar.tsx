"use client";

import { CmdkPanel } from "@/components/thread/command/cmdk-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { LogOut, PanelLeft, Plus, Search, User } from "lucide-react";
/**
 * Desktop 会话侧栏（W3-2）。
 *
 * 结构（自上而下）：
 * 1. macOS 红绿灯安全区（普通窗口 32px，原生全屏 / Web 预览为 0）。
 * 2. 品牌行：SnowHarness + 搜索按钮（打开 ⌘K）。
 * 3. 新建会话。
 * 4. "会话"区标题。
 * 5. 会话列表（按主智能体分组；未选助手的平铺顶部）。
 * 6. 底部账号行（点击弹出账户身份与退出入口）。
 *
 * 侧栏可收起（⌘\ 或品牌行按钮），收起后主区左移。
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type CSSProperties, useEffect, useState } from "react";
import { useSidebar } from "./sidebar-context";

interface SidebarThread {
  readonly id: string;
  readonly title: string | null;
  readonly latest_turn_state?: string | null;
}

interface DesktopSidebarProps {
  readonly threads: readonly SidebarThread[];
  readonly currentThreadId?: string;
  readonly userName?: string;
  readonly hasNativeTitlebar?: boolean;
  readonly surface?: "web" | "desktop";
}

interface DesktopWindowControls {
  getFrameState(): Promise<{ isFullScreen: boolean }>;
  onFrameStateChange(callback: (state: { isFullScreen: boolean }) => void): () => void;
}

const nativeNoDragStyle = { WebkitAppRegion: "no-drag" } as unknown as CSSProperties;

export function DesktopSidebar({
  threads,
  currentThreadId: currentThreadIdProp,
  userName,
  hasNativeTitlebar = false,
  surface = "desktop",
}: DesktopSidebarProps) {
  const { collapsed, isNarrow, toggle } = useSidebar();
  const pathname = usePathname();
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [nativeTitlebar, setNativeTitlebar] = useState(hasNativeTitlebar);
  const [nativeIsFullScreen, setNativeIsFullScreen] = useState<boolean | null>(null);

  useEffect(() => {
    const controls = (
      globalThis as unknown as {
        snowDesktop?: { windowControls?: DesktopWindowControls };
      }
    ).snowDesktop?.windowControls;
    if (!controls) return;

    setNativeTitlebar(true);

    let active = true;
    void controls
      .getFrameState()
      .then((state) => {
        if (active) setNativeIsFullScreen(state.isFullScreen);
      })
      .catch(() => {
        // 旧 preload 不支持窗口状态时，保守保持普通窗口布局。
      });
    const unsubscribe = controls.onFrameStateChange((state) => {
      setNativeIsFullScreen(state.isFullScreen);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // ⌘K 快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // 从 /desktop/chat/[threadId] 推导当前会话 id；prop 优先
  const currentThreadId =
    currentThreadIdProp ?? pathname?.replace("/desktop/chat/", "").split("/")[0];
  const isFullScreen = nativeTitlebar && nativeIsFullScreen === true;
  const displayName = userName?.trim() || "用户";
  const avatarLabel =
    displayName.charCodeAt(0) <= 0x7f
      ? displayName.slice(0, 2).toUpperCase()
      : Array.from(displayName)[0];
  // 无论普通窗口还是原生全屏，顶部都要为窗口控制保留一行，避免与品牌行重叠。
  const titlebarSpacerClass = nativeTitlebar ? "h-8" : "h-0";
  const titlebarControlsClass = nativeTitlebar
    ? !isFullScreen
      ? "top-2 left-20"
      : "top-2 left-3"
    : collapsed
      ? "top-2 left-3"
      : surface === "web" && isNarrow
        ? "top-[calc(var(--sidebar-overlay-inset)+0.5rem)] left-[calc(var(--sidebar-overlay-inset)+var(--sidebar-width)-6.75rem)]"
        : "top-2 left-[calc(var(--sidebar-width)-6.75rem)]";
  const titlebarIconClass =
    "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
  const panelButton = (
    <button
      type="button"
      onClick={toggle}
      style={nativeNoDragStyle}
      className={titlebarIconClass}
      aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
    >
      <PanelLeft className="size-4" strokeWidth={1.5} />
    </button>
  );
  const searchButton = (
    <button
      type="button"
      onClick={() => setCmdkOpen(true)}
      style={nativeNoDragStyle}
      className={titlebarIconClass}
      aria-label="搜索会话"
    >
      <Search className="size-4" strokeWidth={1.5} />
    </button>
  );
  const newThreadButton = (
    <Link
      href={surface === "desktop" ? "/desktop" : "/chat"}
      aria-label="新建会话"
      style={nativeNoDragStyle}
      className={titlebarIconClass}
    >
      <Plus className="size-4" strokeWidth={1.5} />
    </Link>
  );

  return (
    <>
      <CmdkPanel threads={threads} open={cmdkOpen} onOpenChange={setCmdkOpen} surface={surface} />
      <div
        data-testid="desktop-titlebar-controls"
        className={cn(
          "fixed z-40 flex items-center gap-1 [-webkit-app-region:no-drag]",
          titlebarControlsClass,
        )}
      >
        {isFullScreen ? (
          collapsed ? (
            <>
              {panelButton}
              {newThreadButton}
              {searchButton}
            </>
          ) : (
            <>
              <span
                data-testid="desktop-titlebar-brand"
                className="px-1 font-semibold text-sm text-foreground"
              >
                SnowHarness
              </span>
              {searchButton}
              {panelButton}
            </>
          )
        ) : (
          <>
            {searchButton}
            {panelButton}
            {collapsed && newThreadButton}
          </>
        )}
      </div>
      {surface === "web" && isNarrow && !collapsed && (
        <>
          <div
            data-testid="desktop-sidebar-backdrop"
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 z-20 bg-black/10 backdrop-blur-[1px]"
          />
          <button
            type="button"
            aria-label="关闭会话侧栏"
            onClick={toggle}
            className="fixed top-0 right-0 bottom-0 left-[calc(var(--sidebar-overlay-inset)+var(--sidebar-width))] z-20 cursor-default"
          />
        </>
      )}
      <aside
        data-testid="desktop-sidebar-shell"
        aria-label="会话侧栏"
        className={cn(
          // 窄屏为带安全边距的浮动 drawer；宽屏为参与主布局的固定侧栏。
          "relative h-full shrink-0 overflow-visible transition-[width] duration-200 ease-out max-[84.9375rem]:fixed max-[84.9375rem]:inset-y-[var(--sidebar-overlay-inset)] max-[84.9375rem]:left-[var(--sidebar-overlay-inset)] max-[84.9375rem]:h-auto max-[84.9375rem]:z-30",
          collapsed ? "w-0" : "w-[var(--sidebar-width)]",
        )}
      >
        <div
          data-testid="desktop-sidebar-panel"
          aria-hidden={collapsed}
          className={cn(
            "absolute inset-y-0 left-0 flex w-[var(--sidebar-width)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[opacity,transform] duration-200 ease-out max-[84.9375rem]:rounded-[clamp(1rem,1.5vw,1.25rem)] max-[84.9375rem]:border max-[84.9375rem]:shadow-[0_18px_48px_-20px_rgba(15,23,42,0.28),0_4px_14px_-8px_rgba(15,23,42,0.18)]",
            collapsed
              ? "pointer-events-none -translate-x-2 opacity-0"
              : "translate-x-0 opacity-100",
          )}
        >
          {nativeTitlebar && !isFullScreen && (
            <div
              data-testid="desktop-titlebar-drag-zone"
              aria-hidden="true"
              className="absolute top-0 right-0 left-[140px] h-8 [-webkit-app-region:drag]"
            />
          )}

          {/* macOS 红绿灯安全区 */}
          <div
            data-testid="desktop-titlebar-spacer"
            className={cn(titlebarSpacerClass, "shrink-0")}
          />

          {/* 全屏时品牌移到标题栏，避免首行重复 */}
          {!isFullScreen && (
            <div className="px-4 pt-2 pb-1.5 [-webkit-app-region:no-drag]">
              <span className="font-semibold text-[15px] tracking-[-0.01em] text-sidebar-foreground">
                SnowHarness
              </span>
            </div>
          )}

          {/* 新建会话 */}
          <div className="px-3 py-1 [-webkit-app-region:no-drag]">
            <Link
              href={surface === "desktop" ? "/desktop" : "/chat"}
              className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40"
            >
              <Plus className="size-4 text-muted-foreground" />
              新建会话
            </Link>
          </div>

          {/* 会话列表 */}
          <ThreadGroupList threads={threads} currentThreadId={currentThreadId} surface={surface} />

          {/* 底部账号行 */}
          <div className="mt-auto [-webkit-app-region:no-drag]">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex w-full items-center gap-2 border-t border-sidebar-border px-4 py-2.5 text-left transition-colors hover:bg-sidebar-accent">
                <div className="flex size-7 items-center justify-center rounded-full bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground">
                  <User className="size-3.5" />
                </div>
                <span className="truncate text-sm text-foreground">{displayName}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                alignOffset={12}
                sideOffset={8}
                className="w-[calc(var(--sidebar-width)-1.5rem)] rounded-2xl border border-foreground/10 bg-popover p-2 shadow-[0_12px_32px_-12px_rgba(15,23,42,0.22),0_2px_8px_-4px_rgba(15,23,42,0.14)] ring-0"
              >
                <div
                  data-testid="account-menu-identity"
                  className="flex min-w-0 items-center gap-2.5 px-2 py-1.5"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[11px] text-muted-foreground"
                  >
                    {avatarLabel}
                  </span>
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {displayName}
                  </span>
                </div>
                <DropdownMenuSeparator className="mx-1 my-1.5" />
                <DropdownMenuItem
                  onSelect={async () => {
                    const desktop = (
                      window as unknown as {
                        desktop?: { auth?: { logout: () => Promise<{ ok: boolean }> } };
                      }
                    ).desktop;
                    if (desktop?.auth?.logout) {
                      await desktop.auth.logout();
                    }
                  }}
                  className="min-h-9 gap-2.5 rounded-lg px-2 py-1.5 text-sm text-foreground focus:bg-accent focus:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <LogOut className="size-4 text-muted-foreground" />
                  退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </aside>
    </>
  );
}

/**
 * 会话列表。
 * - 全部平铺（Agent 与 Runtime Authority §15/§35：Thread 不再绑主 Agent，primary_agent_id 已移除，
 *   不再按 Agent 分组；Agent 目录为空时无分组语义）。
 * - 当前会话浅灰底高亮。
 */
function ThreadGroupList({
  threads,
  currentThreadId,
  surface,
}: {
  readonly threads: readonly SidebarThread[];
  readonly currentThreadId?: string;
  readonly surface: "web" | "desktop";
}) {
  return (
    <nav
      className="flex-1 overflow-y-auto px-3 pt-3 [-webkit-app-region:no-drag]"
      aria-label="会话列表"
    >
      {threads.map((t) => (
        <ThreadListItem
          key={t.id}
          thread={t}
          isActive={t.id === currentThreadId}
          surface={surface}
        />
      ))}
    </nav>
  );
}

function ThreadListItem({
  thread,
  isActive,
  surface,
}: {
  readonly thread: SidebarThread;
  readonly isActive: boolean;
  readonly surface: "web" | "desktop";
}) {
  // 窄屏（overlay drawer）中选择会话后自动关闭抽屉；宽屏固定侧栏保持展开。
  const { isNarrow, setCollapsed } = useSidebar();
  return (
    <Link
      href={surface === "desktop" ? `/desktop/chat/${thread.id}` : `/chat/${thread.id}`}
      onClick={() => {
        if (isNarrow) setCollapsed(true);
      }}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40",
        isActive
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
      )}
      title={thread.title ?? "新会话"}
    >
      <span className="min-w-0 flex-1 truncate">{thread.title ?? "新会话"}</span>
      {thread.latest_turn_state === "waiting_user" ? (
        <span
          data-thread-status="needs-input"
          className="shrink-0 rounded-full bg-accent px-2 py-0.5 font-medium text-[10px] leading-4 text-accent-foreground"
        >
          需要用户输入
        </span>
      ) : null}
    </Link>
  );
}
