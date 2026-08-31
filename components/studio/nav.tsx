"use client";

import { ThemeToggle } from "@/components/studio/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Search,
  ServerCog,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

/**
 * Studio 的一级导航。菜单权限由服务端计算，本组件只负责展示、路由归属与本地搜索。
 * 搜索始终在权限过滤之后进行，不能让服务端隐藏的菜单重新出现。
 */

type NavItem = {
  readonly id: string;
  readonly href: string;
  readonly labelKey: string;
  readonly icon: LucideIcon;
  readonly aliases: readonly string[];
  readonly navId?: keyof StudioNavVisibility;
  readonly keywords?: readonly string[];
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
        keywords: ["首页", "概览"],
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
        keywords: ["资源", "发布", "路由"],
      },
      {
        id: "capabilities",
        href: "/studio/capabilities",
        labelKey: "studio.nav.capabilities",
        icon: Blocks,
        aliases: ["/studio/capabilities", "/studio/skills", "/studio/artifacts"],
        navId: "capabilities",
        keywords: ["技能", "工具", "知识", "产物"],
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
        keywords: ["环境", "桌面"],
      },
      {
        id: "observability",
        href: "/studio/observability",
        labelKey: "studio.nav.observability",
        icon: Activity,
        aliases: ["/studio/observability"],
        navId: "observability",
        keywords: ["追踪", "评测", "告警"],
      },
      {
        id: "operations",
        href: "/studio/operations",
        labelKey: "studio.nav.operations",
        icon: ChartNoAxesCombined,
        aliases: ["/studio/operations", "/studio/analytics"],
        navId: "operations",
        keywords: ["用量", "成本", "容量", "配额"],
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
        keywords: ["策略", "权限", "凭证", "审计"],
      },
      {
        id: "settings",
        href: "/studio/settings",
        labelKey: "studio.nav.settings",
        icon: Settings2,
        aliases: ["/studio/settings"],
        navId: "settings",
        keywords: ["用户", "角色", "组织", "配置"],
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

interface StudioNavProps {
  /** 一级菜单可见性，由 server 端计算。 */
  readonly visibleItems: StudioNavVisibility;
}

interface NavPanelProps {
  readonly variant: "desktop" | "mobile";
  readonly pathname: string;
  readonly groups: readonly NavGroup[];
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}

function NavPanel({ variant, pathname, groups, query, onQueryChange }: NavPanelProps) {
  const mobile = variant === "mobile";

  return (
    <nav
      aria-label={mobile ? "移动后台菜单" : "管理后台"}
      className={cn(
        "w-68 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        mobile
          ? "fixed inset-y-0 left-0 z-40 flex animate-in slide-in-from-left shadow-sm duration-200 motion-reduce:animate-none md:hidden"
          : "hidden h-full md:flex",
      )}
    >
      <div className={cn("px-3", mobile ? "pt-14" : "pt-3")}>
        <Link
          href="/chat"
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/50"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          <span>返回使用端</span>
        </Link>
      </div>

      <div className="px-5 pt-5 pb-3">
        <div className="text-sm font-semibold tracking-tight">管理后台</div>
        <p className="mt-0.5 text-xs text-muted-foreground">SnowHarness</p>
      </div>

      <div className="relative px-3 pb-3">
        <Search
          className="pointer-events-none absolute top-2 left-5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          aria-label="搜索后台菜单"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="搜索设置与功能"
          className="border-sidebar-border bg-background/70 pl-8 shadow-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {groups.length > 0 ? (
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group.id} aria-labelledby={`studio-nav-${variant}-${group.id}`}>
                <h2
                  id={`studio-nav-${variant}-${group.id}`}
                  className="px-2 pb-1.5 text-xs font-medium text-muted-foreground"
                >
                  {group.label}
                </h2>
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
        ) : (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">没有匹配的菜单</p>
        )}
      </div>

      <div className="border-t border-sidebar-border p-3">
        <ThemeToggle />
      </div>
    </nav>
  );
}

export function StudioNav({ visibleItems }: StudioNavProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [query, setQuery] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 变化是关闭移动抽屉的触发信号
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const visibleGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");

    return NAV_GROUPS.map((group) => {
      const permittedItems = group.items.filter(
        (item) => item.navId === undefined || visibleItems[item.navId],
      );
      const items = normalizedQuery
        ? permittedItems.filter((item) => {
            const searchableText = [t(item.labelKey), group.label, ...(item.keywords ?? [])]
              .join(" ")
              .toLocaleLowerCase("zh-CN");
            return searchableText.includes(normalizedQuery);
          })
        : permittedItems;

      return { ...group, items };
    }).filter((group) => group.items.length > 0);
  }, [query, visibleItems]);

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

      <NavPanel
        variant="desktop"
        pathname={pathname}
        groups={visibleGroups}
        query={query}
        onQueryChange={setQuery}
      />

      {mobileOpen && (
        <NavPanel
          variant="mobile"
          pathname={pathname}
          groups={visibleGroups}
          query={query}
          onQueryChange={setQuery}
        />
      )}
    </>
  );
}
