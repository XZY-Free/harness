import { MetricCard } from "@/components/studio/metric-card";
import { listAgents } from "@/lib/agents/persistence/agent-queries";
import { getPolicyConfigRows, listSkills } from "@/lib/db/studio-queries";
import { resolvePrincipal } from "@/lib/identity/resolver";
import { resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { headers } from "next/headers";
import Link from "next/link";

/**
 * Agent Studio 总览。
 *
 * 全 server component,只读聚合仪表盘（正式 Skill / Agent / policy 视角）：
 * - 资源计数:skills(active)/ agents。
 * - policy 摘要。
 *
 * 门禁 = studio.access(layout 已保证)。旧 analytics 面板已随本地执行体系移除；
 * 旧 legacy threads/artifacts 段已随 Studio threads 页移除（P2-delete）；
 * 正式执行指标由管理控制面（admin Invocation/Job 排障页）提供。
 */
export const dynamic = "force-dynamic";

// P2 i18n: 共享字典（STATUS_LABEL 已随 legacy threads 段移除）。
import { t } from "@/lib/i18n";

export default async function StudioOverviewPage() {
  const requestHeaders = await headers();
  const adminPrincipal = await resolvePrincipal(requestHeaders, "admin");

  const [skills, agents, policyRows] = await Promise.all([
    listSkills(),
    listAgents(adminPrincipal.tenantId),
    getPolicyConfigRows(),
  ]);

  const activeSkills = skills.filter((s) => s.status === "active").length;
  const policyKeys = new Set(policyRows.map((r) => r.key));
  const POLICY_LABELS: Record<string, string> = {
    protectedPaths: "受保护路径",
    commandDenyList: "命令黑名单",
    formatOnWrite: "写入格式化",
    verifyBeforeDelivery: "交付前校验",
  };

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

      {/* ── 策略摘要 ── */}
      <section>
        <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wider text-[var(--fg-subtle)]">
          {t("studio.overview.section.policy")}
        </h2>
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[var(--fg)]">
              {t("studio.overview.policy_summary")}
            </h2>
            <Link
              href="/studio/policies"
              className="text-[12px] text-[var(--primary)] hover:underline"
            >
              {t("common.detail")}
            </Link>
          </div>
          <ul className="space-y-1.5 text-[13px]">
            {Object.entries(POLICY_LABELS).map(([key, label]) => {
              const configured = policyKeys.has(key);
              return (
                <li key={key} className="flex items-center justify-between">
                  <span className="text-[var(--fg-muted)]">{label}</span>
                  <span className={configured ? "text-[var(--ok)]" : "text-[var(--fg-subtle)]"}>
                    {configured
                      ? t("studio.overview.policy.configured")
                      : t("studio.overview.policy.not_configured")}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}
