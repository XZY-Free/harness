import { MetricCard } from "@/components/studio/metric-card";
import { listAgents } from "@/lib/agents/persistence/agent-queries";
import {
  getPolicyConfigRows,
  listAllThreads,
  listRecentArtifactsForUser,
  listSkills,
  listThreadsForUser,
} from "@/lib/db/studio-queries";
import { resolvePrincipal } from "@/lib/identity/resolver";
import { hasStudioAction, resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { headers } from "next/headers";
import Link from "next/link";

/**
 * Agent Studio 总览。
 *
 * 全 server component,只读聚合仪表盘（正式 Thread / Skill / Agent / 产物视角）：
 * - 资源计数:skills(active)/ agents / providers。
 * - 最近会话 / 最近产物(owner-scoped)。
 * - policy 摘要。
 *
 * 门禁 = studio.access(layout 已保证)。旧 analytics 面板已随本地执行体系移除；
 * 正式执行指标由管理控制面（admin Invocation/Job 排障页）提供。
 */
export const dynamic = "force-dynamic";

// P2 i18n: STATUS_LABEL 改用 lib/i18n 共享字典。
import { STATUS_LABEL as STATUS_LABEL_DICT, t } from "@/lib/i18n";
const STATUS_LABEL = STATUS_LABEL_DICT.zh;

export default async function StudioOverviewPage() {
  const requestHeaders = await headers();
  const [principal, adminPrincipal] = await Promise.all([
    resolveStudioPrincipal(requestHeaders),
    resolvePrincipal(requestHeaders, "admin"),
  ]);
  const canAllThreads = await hasStudioAction(principal, "thread.read");

  const [skills, threads, agents, policyRows, recentArtifacts] = await Promise.all([
    listSkills(),
    canAllThreads ? listAllThreads() : listThreadsForUser(principal.userIdentityId),
    listAgents(adminPrincipal.tenantId),
    getPolicyConfigRows(),
    listRecentArtifactsForUser(principal.userIdentityId, canAllThreads, 5),
  ]);

  const activeSkills = skills.filter((s) => s.status === "active").length;
  const recentThreads = threads.slice(0, 5);
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
          <MetricCard
            label={t("studio.overview.metric.threads")}
            value={threads.length}
            sub={
              canAllThreads
                ? t("studio.overview.metric.threads_global")
                : t("studio.overview.metric.threads_self")
            }
          />
        </div>
      </section>

      {/* ── 最近会话 / 最近产物 ── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[var(--fg)]">
              {t("studio.overview.section.recent_threads")}
            </h2>
            <Link
              href="/studio/threads"
              className="text-[12px] text-[var(--primary)] hover:underline"
            >
              {t("common.view_all")}
            </Link>
          </div>
          {recentThreads.length === 0 ? (
            <div className="py-4 text-center text-[13px] text-[var(--fg-muted)]">
              {t("studio.overview.empty.threads")}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)] text-[13px]">
              {recentThreads.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2">
                  <Link
                    href={`/studio/threads/${t.id}`}
                    className="min-w-0 flex-1 truncate text-[var(--primary)] hover:underline"
                    title={t.title || t.id}
                  >
                    {t.title || (
                      <span className="font-mono text-[var(--fg-muted)]">{t.id.slice(0, 8)}</span>
                    )}
                  </Link>
                  <span className="shrink-0 text-[var(--fg-muted)]">
                    {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                  <span className="shrink-0 text-[var(--fg-subtle)]">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="mb-2 text-[15px] font-semibold text-[var(--fg)]">
            {t("studio.overview.section.recent_artifacts")}
          </h2>
          {recentArtifacts.length === 0 ? (
            <div className="py-4 text-center text-[13px] text-[var(--fg-muted)]">
              {t("studio.overview.empty.artifacts")}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)] text-[13px]">
              {recentArtifacts.map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2">
                  <Link
                    href={`/studio/threads/${a.threadId}`}
                    className="min-w-0 flex-1 truncate text-[var(--primary)] hover:underline"
                    title={a.threadTitle ?? a.threadId}
                  >
                    {a.threadTitle ?? (
                      <span className="font-mono text-[var(--fg-muted)]">
                        {a.threadId.slice(0, 8)}
                      </span>
                    )}
                  </Link>
                  <span className="shrink-0 text-[var(--fg-muted)]">
                    {a.type === "artifact.created"
                      ? t("studio.overview.artifact.created")
                      : t("studio.overview.artifact.updated")}
                  </span>
                  <span className="shrink-0 text-[var(--fg-subtle)]">
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

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
