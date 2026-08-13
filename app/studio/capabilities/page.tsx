import { StudioGatePage } from "@/components/studio/gate-page";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";
import Link from "next/link";

/**
 * 统一管理后台 — 能力与知识页（S11-W01 占位）。
 *
 * 一级导航「能力与知识」整合原 /studio/resources + /studio/skills + /studio/providers + /studio/artifacts。
 * 本页为 S11-W01 重组后的着陆页，提供到现有子页面的入口；
 * S11-W03 将在此页直接渲染 Skill / Tool / Knowledge / Connection 一体化管理。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *   「能力与知识」：Skill、Tool、Knowledge、模型、连接、来源和风险变化
 */
export const dynamic = "force-dynamic";

interface SectionLink {
  readonly href: string;
  readonly title: string;
  readonly description: string;
}

const SECTIONS: readonly SectionLink[] = [
  {
    href: "/studio/skills",
    title: "技能 Skill",
    description: "技能定义、版本、发布与回滚。",
  },
  {
    href: "/studio/resources?tab=providers",
    title: "模型提供方 Provider",
    description: "模型供应方连接配置。",
  },
  {
    href: "/studio/resources?tab=agents",
    title: "智能体 Agent",
    description: "智能体元数据档案。",
  },
  {
    href: "/studio/artifacts",
    title: "产物 Artifact",
    description: "Artifact 列表与索引。",
  },
];

export default async function CapabilitiesPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">能力与知识</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        统一管理 Skill、Tool、Knowledge、SchemaRevision、CatalogEntry、模型连接与风险变化。 S11-W03
        将在此页直接渲染能力内容；当前阶段可访问以下既有子页面。
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
