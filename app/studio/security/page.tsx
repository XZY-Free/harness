import { StudioGatePage } from "@/components/studio/gate-page";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";
import Link from "next/link";

/**
 * 统一管理后台 — 安全与审计页（S11-W01 整合）。
 *
 * 一级导航「安全与审计」整合原 /studio/audit + /studio/policies + 权限规则 +
 * Credential 引用 + Legal Hold + 删除请求。本页提供入口聚合，
 * S11-W08 将扩展并发控制、导出审计与端到端验证。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *   「安全与审计」：Policy、Permission、Credential 引用、Effect、Audit 和事件处置
 */
export const dynamic = "force-dynamic";

interface SectionLink {
  readonly href: string;
  readonly title: string;
  readonly description: string;
}

const SECTIONS: readonly SectionLink[] = [
  {
    href: "/studio/audit",
    title: "审计日志 Audit",
    description: "查看、导出管理员操作审计记录（导出产生新审计事件）。",
  },
  {
    href: "/studio/policies",
    title: "策略 Policy",
    description: "策略配置与版本（PolicyRevision 发布由 S11-W08 接入）。",
  },
  {
    href: "/studio/settings",
    title: "用户角色 Roles",
    description: "管理员角色与权限绑定（role_action_binding）。",
  },
];

export default async function SecurityPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">安全与审计</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        Policy 发布、Permission 决策、Credential 引用、Effect、Audit 与事件处置。 Credential
        原值在任何角色下均不可见（方案 §S11-W01）。
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="block rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--primary)]/40 hover:bg-[var(--surface-2)]"
          >
            <div className="font-medium text-[15px] text-[var(--fg)]">{section.title}</div>
            <div className="mt-1 text-[12px] text-[var(--fg-muted)]">{section.description}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
