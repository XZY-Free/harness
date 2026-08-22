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
import { LogOut, PanelLeft, Plus, Search, Settings, User } from "lucide-react";
/**
 * Desktop 会话侧栏（W3-2）。
 *
 * 结构（自上而下）：
 * 1. macOS 红绿灯安全区（普通窗口 32px，原生全屏 / Web 预览为 0）。
 * 2. 品牌行：SnowHarness + 搜索按钮（打开 ⌘K）。
 * 3. 新建会话。
 * 4. "会话"区标题。
 * 5. 会话列表（按主智能体分组；未选助手的平铺顶部）。
 * 6. 底部账号行（点击弹出菜单：设置 / 退出登录）。
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
  // 无论普通窗口还是原生全屏，顶部都要为窗口控制保留一行，避免与品牌行重叠。
  const titlebarSpacerClass = nativeTitlebar ? "h-8" : "h-0";
  const titlebarControlsClass = nativeTitlebar
    ? !isFullScreen
      ? "top-2 left-20"
      : "top-2 left-3"
    : collapsed
      ? "top-2 left-3"
      : "top-2 left-[132px]";
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
      href={surface === "desktop" ? "/desktop/new" : "/chat/new"}
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
        <button
          type="button"
          aria-label="关闭会话侧栏"
          onClick={toggle}
          className="fixed inset-0 z-20 bg-black/15"
        />
      )}
      <aside
        aria-label="会话侧栏"
        className={cn(
          // <1180px 一律 overlay drawer（不参与主布局）；≥1180px 为固定侧栏（参与布局）。
          "relative h-full shrink-0 overflow-visible transition-[width] duration-200 ease-out max-[1179px]:fixed max-[1179px]:inset-y-0 max-[1179px]:left-0 max-[1179px]:z-30",
          collapsed ? "w-0" : "w-[236px]",
        )}
      >
        <div
          aria-hidden={collapsed}
          className={cn(
            "absolute inset-y-0 left-0 flex w-[236px] flex-col border-r border-border bg-muted/85 transition-[opacity,transform] duration-200 ease-out",
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
            <div className="px-4 py-1.5 [-webkit-app-region:no-drag]">
              <span className="font-semibold text-sm text-foreground">SnowHarness</span>
            </div>
          )}

          {/* 新建会话 */}
          <div className="px-3 py-1 [-webkit-app-region:no-drag]">
            <Link
              href={surface === "desktop" ? "/desktop/new" : "/chat/new"}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Plus className="size-4 text-muted-foreground" />
              新建会话
            </Link>
          </div>

          {/* 会话区标题 */}
          <div className="px-4 py-2">
            <h2 className="text-sm font-semibold text-foreground">会话</h2>
          </div>

          {/* 会话列表 */}
          <ThreadGroupList threads={threads} currentThreadId={currentThreadId} surface={surface} />

          {/* 底部账号行 */}
          <div className="mt-auto [-webkit-app-region:no-drag]">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex w-full items-center gap-2 border-t border-border px-4 py-2.5 text-left transition hover:bg-secondary">
                <div className="flex size-7 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
                  <User className="size-3.5" />
                </div>
                <span className="truncate text-sm text-foreground">{userName ?? "用户"}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-48">
                <DropdownMenuItem
                  onSelect={() => {
                    /* W3-5 后接入设置面板；现阶段无操作 */
                  }}
                >
                  <Settings className="size-4" />
                  设置
                  <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘,</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
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
                >
                  <LogOut className="size-4" />
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
 * - 全部平铺（专题01 §15/§35：Thread 不再绑主 Agent，primary_agent_id 已移除，
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
    <nav className="flex-1 overflow-y-auto px-3 [-webkit-app-region:no-drag]" aria-label="会话列表">
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
        "block truncate rounded-md px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        isActive
          ? "bg-secondary font-medium text-foreground"
          : "text-foreground hover:bg-secondary/60",
      )}
      title={thread.title ?? "新会话"}
    >
      {thread.title ?? "新会话"}
    </Link>
  );
}
