import { MetricCard } from "@/components/studio/metric-card";
import { listAgents } from "@/lib/agents/persistence/agent-queries";
import { listSkills } from "@/lib/capability/skill-studio-queries";
import { resolvePrincipal } from "@/lib/identity/resolver";
import { resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { headers } from "next/headers";

/**
 * Agent Studio 总览。
 *
 * 全 server component,只读聚合仪表盘（正式 Skill / Agent 视角）：
 * - 资源计数:skills(active)/ agents。
 *
 * 门禁 = studio.access(layout 已保证)。旧 analytics 面板已随本地执行体系移除；
 * 旧 legacy threads/artifacts 段已随 Studio threads 页移除（P2-delete）；
 * 旧 legacy PolicyConfig KV 策略摘要段已随 02-6 P9 legacy 物理删除移除——
 * 正式 Policy Revision 的查看/编辑由 /studio/governance 承接。
 * 正式执行指标由管理控制面（admin Invocation/Job 排障页）提供。
 */
export const dynamic = "force-dynamic";

// P2 i18n: 共享字典（STATUS_LABEL 已随 legacy threads 段移除）。
import { t } from "@/lib/i18n";

export default async function StudioOverviewPage() {
  const requestHeaders = await headers();
  const adminPrincipal = await resolvePrincipal(requestHeaders, "admin");

  const [skills, agents] = await Promise.all([
    listSkills(adminPrincipal.tenantId, undefined, { activeOnly: true }),
    listAgents(adminPrincipal.tenantId),
  ]);

  // listSkills(activeOnly=true) 已只返回 lifecycleState=enabled 的 skill
  const activeSkills = skills.length;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <h1 className="text-[22px] font-semibold text-[var(--fg)]">{t("studio.overview.title")}</h1>
      </div>

      {/* ── 资源计数 ── */}
      <section>
        <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wider text-[var(--fg-subtle)]">
          {t("studio.overview.section.resources")}
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <MetricCard
            label={t("studio.overview.metric.active_skills")}
            value={activeSkills}
            sub={`共 ${skills.length} 条`}
          />
          <MetricCard
            label={t("studio.overview.metric.agents")}
            value={agents.length}
            sub={t("studio.overview.metric.agents_sub")}
          />
        </div>
      </section>
    </div>
  );
}
