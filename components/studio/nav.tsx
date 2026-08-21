"use client";

import { Icon } from "@/components/icons";
import { ThemeToggle } from "@/components/studio/theme-toggle";
import { t } from "@/lib/i18n";
import type { StudioNavVisibility } from "@/lib/studio/nav-visibility";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * 统一管理后台一级导航（S11-W01 重组）。
 *
 * 7 个一级菜单（按方案 §后台信息架构）：
 * 1. 智能体（/studio/agents）— Agent / Revision / Route / 发布
 * 2. 能力与知识（/studio/capabilities）— Skill / Tool / Knowledge / Connection / 风险变化
 * 3. Runtime 与环境（/studio/runtime）— RuntimeRevision / Environment / Desktop
 * 4. 观测与评测（/studio/observability）— Trace / Observation / Evaluation / 实验和告警
 * 5. 安全与审计（/studio/security）— Policy / Permission / Credential / Audit / Legal Hold
 * 6. 运营（/studio/operations）— 使用量 / 成本 / 容量 / 配额 / 失败与服务水平
 * 7. 平台设置（/studio/settings）— 组织 / 身份 / 模型供应方 / 保留策略 / 平台参数
 *
 * 原「会话与协作（/studio/threads）」菜单已随 legacy Studio threads 页移除（P2-closeout）。
 * 员工侧会话 UI 由 /chat 提供（正式 Employee Thread API）。
 *
 * 菜单可见性由 server 端 `computeStudioNavVisibility` 计算，通过 `visibleItems` prop 传入。
 * 隐藏菜单不渲染，但服务端 Action Scope 校验仍然独立执行（菜单可见性不能代替授权）。
 *
 * 12-P2-6：移动端适配——小屏（< md）侧栏收起，hamburger 按钮控制展开/收起；
 * md+ 始终展开。收起态点击导航项后自动收起。
 */

type NavItem = {
  href: string;
  labelKey: string;
  icon: React.ReactNode;
  navId: keyof StudioNavVisibility;
};

const ITEMS: NavItem[] = [
  {
    href: "/studio/agents",
    labelKey: "studio.nav.agents",
    icon: <Icon.snowflake size={16} />,
    navId: "agents",
  },
  {
    href: "/studio/capabilities",
    labelKey: "studio.nav.capabilities",
    icon: <Icon.write size={16} />,
    navId: "capabilities",
  },
  {
    href: "/studio/runtime",
    labelKey: "studio.nav.runtime",
    icon: <Icon.settings size={16} />,
    navId: "runtime",
  },
  {
    href: "/studio/observability",
    labelKey: "studio.nav.observability",
    icon: <Icon.read size={16} />,
    navId: "observability",
  },
  {
    href: "/studio/security",
    labelKey: "studio.nav.security",
    icon: <Icon.settings size={16} />,
    navId: "security",
  },
  {
    href: "/studio/operations",
    labelKey: "studio.nav.operations",
    icon: <Icon.list size={16} />,
    navId: "operations",
  },
  {
    href: "/studio/settings",
    labelKey: "studio.nav.settings",
    icon: <Icon.settings size={16} />,
    navId: "settings",
  },
];

function isActive(pathname: string, href: string): boolean {
  // /studio 首页 = 总览（不属于 7 大菜单，是默认着陆页）
  if (href === "/studio") return pathname === "/studio";
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface StudioNavProps {
  /** 7 大菜单可见性（server 端计算，client 接收）。 */
  readonly visibleItems: StudioNavVisibility;
}

export function StudioNav({ visibleItems }: StudioNavProps) {
  const pathname = usePathname();
  // 小屏侧栏开合态：默认收起（小屏），md+ 由 CSS 强制展开（CSS 覆盖 state）
  const [mobileOpen, setMobileOpen] = useState(false);

  // 路由切换后自动收起小屏侧栏（点击导航项跳转后体验）
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 是触发信号（路由变化时收起），非直接引用
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // 总览（/studio）始终可见（任何通过 studio.access 的管理员都能看），
  // 其余 7 项按 visibleItems 过滤。
  const visibleMainItems = ITEMS.filter((item) => visibleItems[item.navId]);

  return (
    <>
      {/* 小屏 hamburger 按钮（< md 显示）—— fixed 定位悬浮左上 */}
      <button
        type="button"
        onClick={() => setMobileOpen((v) => !v)}
        aria-label={mobileOpen ? t("studio.nav.close") : t("studio.nav.open")}
        aria-expanded={mobileOpen}
        className="fixed top-3 left-3 z-50 flex size-9 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] shadow-[var(--shadow-sm)] md:hidden"
      >
        {mobileOpen ? <Icon.close size={16} /> : <Icon.list size={16} />}
      </button>

      {/* 遮罩：小屏展开时点遮罩收起 */}
      {mobileOpen && (
        <button
          type="button"
          aria-label={t("studio.nav.close")}
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      )}

      <nav
        className={`fixed top-0 left-0 z-40 flex h-full w-[220px] shrink-0 flex-col gap-1 border-r border-[var(--border)] bg-[var(--surface)] p-3 transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-3 px-2 text-[12px] font-semibold uppercase tracking-wider text-[var(--fg-subtle)]">
          {t("studio.nav.title")}
        </div>
        {/* 总览（始终可见） */}
        <Link
          href="/studio"
          className={`flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-[14px] transition ${
            isActive(pathname, "/studio")
              ? "bg-[var(--accent-soft)] font-medium text-[var(--primary)]"
              : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          }`}
        >
          <span className="shrink-0">
            <Icon.snowflake size={16} />
          </span>
          {t("studio.nav.overview")}
        </Link>
        {/* 7 大菜单（按 visibleItems 过滤） */}
        {visibleMainItems.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-[14px] transition ${
                active
                  ? "bg-[var(--accent-soft)] font-medium text-[var(--primary)]"
                  : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
              }`}
            >
              <span className="shrink-0">{item.icon}</span>
              {t(item.labelKey)}
            </Link>
          );
        })}
        <div className="mt-auto pt-2">
          <ThemeToggle />
        </div>
      </nav>
    </>
  );
}
