"use client";

import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import type { StudioNavVisibility } from "@/lib/studio/nav-visibility";
import { cn } from "@/lib/utils";
import {
  Activity,
  ArrowLeft,
  Blocks,
  Bot,
  ChartNoAxesCombined,
  LayoutDashboard,
  type LucideIcon,
  Menu,
  ServerCog,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

/**
 * Studio 一级导航（侧栏改版 v3，合同见 docs/V12/01/admin-shell-redesign-demo）。
 *
 * - 头部仅「返回使用端」一个动作：上下文标识由动作语义承载，不设产品标题块。
 * - 不设嵌入搜索：再引入阈值＝一级目的地 ≥10 或设置两级化，届时做全局命令面板。
 * - 渐进分组标签：组内可见项 ≥2 才显示标签；隐藏时保留簇间距维持分组感。
 * - 外观设置已迁往平台设置；导航不承载主题入口。
 * - 三档响应式（Web/Desktop 共用一套）：≥1024 全栏 240px；768–1023 图标 rail 56px；
 *   <768 汉堡＋抽屉。
 *
 * 菜单权限由服务端计算（S11-W01），本组件只负责展示与路由归属。
 */

type NavItem = {
  readonly id: string;
  readonly href: string;
  readonly labelKey: string;
  readonly icon: LucideIcon;
  readonly aliases: readonly string[];
  readonly navId?: keyof StudioNavVisibility;
};

type NavGroup = {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NavItem[];
};

const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "workspace",
    label: "工作台",
    items: [
      {
        id: "overview",
        href: "/studio",
        labelKey: "studio.nav.overview",
        icon: LayoutDashboard,
        aliases: ["/studio"],
      },
    ],
  },
  {
    id: "build",
    label: "构建",
    items: [
      {
        id: "agents",
        href: "/studio/agents",
        labelKey: "studio.nav.agents",
        icon: Bot,
        aliases: ["/studio/agents", "/studio/resources"],
        navId: "agents",
      },
      {
        id: "capabilities",
        href: "/studio/capabilities",
        labelKey: "studio.nav.capabilities",
        icon: Blocks,
        aliases: ["/studio/capabilities", "/studio/skills", "/studio/artifacts"],
        navId: "capabilities",
      },
    ],
  },
  {
    id: "run",
    label: "运行",
    items: [
      {
        id: "runtime",
        href: "/studio/runtime",
        labelKey: "studio.nav.runtime",
        icon: ServerCog,
        aliases: ["/studio/runtime"],
        navId: "runtime",
      },
      {
        id: "observability",
        href: "/studio/observability",
        labelKey: "studio.nav.observability",
        icon: Activity,
        aliases: ["/studio/observability"],
        navId: "observability",
      },
      {
        id: "operations",
        href: "/studio/operations",
        labelKey: "studio.nav.operations",
        icon: ChartNoAxesCombined,
        aliases: ["/studio/operations", "/studio/analytics"],
        navId: "operations",
      },
    ],
  },
  {
    id: "governance",
    label: "治理",
    items: [
      {
        id: "security",
        href: "/studio/security",
        labelKey: "studio.nav.security",
        icon: ShieldCheck,
        aliases: [
          "/studio/security",
          "/studio/audit",
          "/studio/governance",
          "/studio/permission-rules",
        ],
        navId: "security",
      },
      {
        id: "settings",
        href: "/studio/settings",
        labelKey: "studio.nav.settings",
        icon: Settings2,
        aliases: ["/studio/settings"],
        navId: "settings",
      },
    ],
  },
];

function routeMatches(pathname: string, alias: string): boolean {
  if (alias === "/studio") return pathname === alias;
  return pathname === alias || pathname.startsWith(`${alias}/`);
}

function isActive(pathname: string, item: NavItem): boolean {
  return item.aliases.some((alias) => routeMatches(pathname, alias));
}

/** 渐进分组标签：组内可见项 ≥2 才显示；＝1 隐藏但保留簇间距。 */
export function shouldShowGroupLabel(visibleItemCount: number): boolean {
  return visibleItemCount >= 2;
}

interface StudioNavProps {
  /** 一级菜单可见性，由 server 端计算。 */
  readonly visibleItems: StudioNavVisibility;
}

interface NavClustersProps {
  readonly pathname: string;
  readonly groups: readonly NavGroup[];
}

/** 全栏/抽屉共用的簇列表：簇内 2px、簇间 12px，标签按渐进规则显示。 */
export function NavClusters({ pathname, groups }: NavClustersProps) {
  if (groups.length === 0) {
    return <p className="px-2 py-8 text-center text-sm text-muted-foreground">没有可见菜单</p>;
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <section key={group.id} aria-label={group.label}>
          {shouldShowGroupLabel(group.items.length) ? (
            <h2 className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">{group.label}</h2>
          ) : null}
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item);
              const ItemIcon = item.icon;

              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-sidebar-ring/50",
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                  )}
                >
                  <ItemIcon className="size-4" aria-hidden="true" />
                  <span className="truncate">{t(item.labelKey)}</span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

const BACK_LINK_CLASS =
  "flex h-9 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/50";

function BackLink() {
  return (
    <Link href="/chat" className={BACK_LINK_CLASS}>
      <ArrowLeft className="size-4" aria-hidden="true" />
      <span>返回使用端</span>
    </Link>
  );
}

interface NavPanelProps {
  readonly pathname: string;
  readonly groups: readonly NavGroup[];
}

/** ≥1024 全栏：240px，返回即头部。 */
function DesktopPanel({ pathname, groups }: NavPanelProps) {
  return (
    <nav
      aria-label="管理后台"
      className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex"
    >
      <div className="px-3 pt-3 pb-1">
        <BackLink />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-4">
        <NavClusters pathname={pathname} groups={groups} />
      </div>
    </nav>
  );
}

/** 768–1023 图标 rail：56px，原生 title 提示，零自定义延迟。 */
function RailPanel({ pathname, groups }: NavPanelProps) {
  return (
    <nav
      aria-label="管理后台"
      className="hidden w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar py-2.5 text-sidebar-foreground md:flex lg:hidden"
    >
      <Link
        href="/chat"
        title="返回使用端"
        aria-label="返回使用端"
        className="flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/50"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
      </Link>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto py-2">
        {groups.map((group) => (
          <div key={group.id} className="flex flex-col gap-1">
            {group.items.map((item) => {
              const active = isActive(pathname, item);
              const ItemIcon = item.icon;
              const label = t(item.labelKey);

              return (
                <Link
                  key={item.id}
                  href={item.href}
                  title={label}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-3 focus-visible:ring-sidebar-ring/50",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                  )}
                >
                  <ItemIcon className="size-4" aria-hidden="true" />
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

/** <768 抽屉：288px，内容与全栏一致。 */
function MobilePanel({ pathname, groups }: NavPanelProps) {
  return (
    <nav
      aria-label="移动后台菜单"
      className="fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 animate-in slide-in-from-left flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm duration-200 motion-reduce:animate-none md:hidden"
    >
      <div className="px-3 pt-14 pb-1">
        <BackLink />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-4">
        <NavClusters pathname={pathname} groups={groups} />
      </div>
    </nav>
  );
}

export function StudioNav({ visibleItems }: StudioNavProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 变化是关闭移动抽屉的触发信号
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const visibleGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.navId === undefined || visibleItems[item.navId]),
      })).filter((group) => group.items.length > 0),
    [visibleItems],
  );

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        onClick={() => setMobileOpen((open) => !open)}
        aria-label={mobileOpen ? t("studio.nav.close") : t("studio.nav.open")}
        aria-expanded={mobileOpen}
        className="fixed top-3 left-3 z-50 bg-background shadow-sm md:hidden"
      >
        {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
      </Button>

      {mobileOpen && (
        <Button
          type="button"
          variant="ghost"
          aria-label="关闭后台菜单"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 h-auto w-auto rounded-none bg-foreground/15 p-0 hover:bg-foreground/15 md:hidden"
        />
      )}

      <DesktopPanel pathname={pathname} groups={visibleGroups} />
      <RailPanel pathname={pathname} groups={visibleGroups} />
      {mobileOpen && <MobilePanel pathname={pathname} groups={visibleGroups} />}
    </>
  );
}
