import { MetricCard, pct } from "@/components/studio/metric-card";
import { ScopePersistence } from "@/components/studio/scope-persistence";
import { listAgents } from "@/lib/agents/persistence/agent-queries";
import {
  type AnalyticsScope,
  avgCompletionMs,
  perSkillPerformance,
  previewSuccessRate,
  skillMatchStats,
  threadSuccessRate,
  toolFailureBreakdown,
} from "@/lib/analytics/queries";
import { getCurrentUserFromRequest } from "@/lib/auth";
import { listProviders } from "@/lib/db/queries";
import {
  getPolicyConfigRows,
  listAllThreads,
  listRecentArtifactsForUser,
  listSkills,
  listThreadsForUser,
} from "@/lib/db/studio-queries";
import { resolvePrincipal } from "@/lib/identity/resolver";
import { hasPermission } from "@/lib/rbac";
import { headers } from "next/headers";
import Link from "next/link";

/**
 * Agent Studio 总览(合并原 /studio/analytics)。
 *
 * 全 server component,只读聚合仪表盘 + 运营分析:
 * - 资源计数:skills(active)/ agents / providers。
 * - 运营指标(原 analytics):会话成功率 / 预览成功率 / 平均完成时长 / 策略拦截率。
 * - 最近会话 / 最近产物(owner-scoped)。
 * - 工具失败分布 / 各技能表现。
 * - policy 摘要。
 *
 * 门禁 = studio.access(layout 已保证);分析模块需 analytics.read.self,全局需 analytics.read.global。
 * scope 用 Link 切 query param(自己 / 全局),仅影响运营指标 + 失败分布 + 各技能表现。
 */
export const dynamic = "force-dynamic";

// P2 i18n: STATUS_LABEL 改用 lib/i18n 共享字典。
import { STATUS_LABEL as STATUS_LABEL_DICT, t } from "@/lib/i18n";
const STATUS_LABEL = STATUS_LABEL_DICT.zh;

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

export default async function StudioOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const sp = await searchParams;
  const requestHeaders = await headers();
  const [user, principal] = await Promise.all([
    getCurrentUserFromRequest({ headers: requestHeaders }),
    resolvePrincipal(requestHeaders, "admin"),
  ]);
  const canAllThreads = await hasPermission(user.id, "thread.read.all");
  const canAnalytics = await hasPermission(user.id, "analytics.read.self");
  const canGlobal = await hasPermission(user.id, "analytics.read.global");
  const global = canGlobal && sp.scope === "global";
  const analyticsScope: AnalyticsScope = global ? {} : { userId: user.id };

  const [
    skills,
    threads,
    agents,
    providers,
    policyRows,
    recentArtifacts,
    threadSuccess,
    previewSuccess,
    avgCompletion,
    perSkill,
    toolFailures,
    skillMatches,
  ] = await Promise.all([
    listSkills(),
    canAllThreads ? listAllThreads() : listThreadsForUser(user.id),
    listAgents(principal.tenantId),
    listProviders(),
    getPolicyConfigRows(),
    listRecentArtifactsForUser(user.id, canAllThreads, 5),
    canAnalytics ? threadSuccessRate(analyticsScope) : null,
    canAnalytics ? previewSuccessRate(analyticsScope) : null,
    canAnalytics ? avgCompletionMs(analyticsScope) : null,
    canAnalytics ? perSkillPerformance(analyticsScope) : null,
    canAnalytics ? toolFailureBreakdown(analyticsScope) : null,
    canAnalytics ? skillMatchStats(analyticsScope) : null,
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
  const maxKindCount = Math.max(1, ...(toolFailures?.byKind ?? []).map((k) => k.count));

  return (
    <div className="space-y-8">
      <ScopePersistence />
      {/* 12-P2-6：小屏标题与 scope 切换堆叠，md+ 横排 */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <h1 className="text-[22px] font-semibold text-[var(--fg)]">{t("studio.overview.title")}</h1>
        {canGlobal && (
          <div className="flex gap-1 self-start rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-0.5 text-[12px] md:self-auto">
            <Link
              href="/studio"
              className={`rounded-[var(--radius-sm)] px-2.5 py-1 ${!global ? "bg-[var(--accent-soft)] text-[var(--primary)]" : "text-[var(--fg-muted)]"}`}
            >
              {t("studio.overview.scope.self")}
            </Link>
            <Link
              href="/studio?scope=global"
              className={`rounded-[var(--radius-sm)] px-2.5 py-1 ${global ? "bg-[var(--accent-soft)] text-[var(--primary)]" : "text-[var(--fg-muted)]"}`}
            >
              {t("studio.overview.scope.global")}
            </Link>
          </div>
        )}
      </div>

      {/* ── 资源计数 ── */}
      <section>
        <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wider text-[var(--fg-subtle)]">
          {t("studio.overview.section.resources")}
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
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
            label={t("studio.overview.metric.providers")}
            value={providers.length}
            sub={t("studio.overview.metric.providers_sub")}
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

      {/* ── 运营指标 ── */}
      {canAnalytics && threadSuccess && previewSuccess && avgCompletion && toolFailures && (
        <section>
          <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wider text-[var(--fg-subtle)]">
            {t("studio.overview.section.metrics")}
          </h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <MetricCard
              label={t("studio.overview.metric.thread_success")}
              value={pct(threadSuccess.successRate)}
              sub={`待审 ${threadSuccess.readyForReview} / 失败 ${threadSuccess.failed}`}
              tone="accent"
            />
            <MetricCard
              label={t("studio.overview.metric.preview_success")}
              value={pct(previewSuccess.successRate)}
              sub={`成功 ${previewSuccess.succeeded} / 失败 ${previewSuccess.failed}`}
              tone="ok"
            />
            <MetricCard
              label={t("studio.overview.metric.avg_completion")}
              value={fmtMs(avgCompletion.avgMs)}
              sub={`样本 ${avgCompletion.count}`}
            />
            <MetricCard
              label={t("studio.overview.metric.policy_intercept")}
              value={pct(toolFailures.policyInterceptRate)}
              sub={`拦截 ${toolFailures.policyIntercepts} / 失败 ${toolFailures.totalFailures}`}
              tone={toolFailures.policyIntercepts > 0 ? "danger" : "default"}
            />
          </div>
        </section>
      )}

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

      {/* ── 分析详情 ── */}
      {canAnalytics && toolFailures && (
        <section>
          <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wider text-[var(--fg-subtle)]">
            {t("studio.overview.section.analysis")}
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="mb-3 text-[15px] font-medium text-[var(--fg)]">
                {t("studio.overview.tool_failures")}
              </h2>
              {toolFailures.byKind.length === 0 ? (
                <div className="text-[13px] text-[var(--fg-muted)]">
                  {t("studio.overview.empty.tool_failures")}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {toolFailures.byKind.map((k) => (
                    <div key={k.failureKind} className="flex items-center gap-3 text-[13px]">
                      <div className="w-24 shrink-0 text-[var(--fg-muted)]">{k.failureKind}</div>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                        <div
                          className="h-full rounded-full bg-[var(--primary)]"
                          style={{ width: `${(k.count / maxKindCount) * 100}%` }}
                        />
                      </div>
                      <div className="w-10 shrink-0 text-right text-[var(--fg)]">{k.count}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="mb-3 text-[15px] font-medium text-[var(--fg)]">
                {t("studio.overview.skill_performance")}
              </h2>
              {perSkill && perSkill.length > 0 ? (
                <div className="overflow-hidden">
                  <table className="w-full text-[13px]">
                    <thead className="text-[var(--fg-subtle)]">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">技能</th>
                        <th className="px-2 py-1 text-left font-medium">总数</th>
                        <th className="px-2 py-1 text-left font-medium">成功率</th>
                        <th className="px-2 py-1 text-left font-medium">时长</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perSkill.map((s, idx) => (
                        <tr
                          key={`${s.skillId ?? "none"}-${idx}`}
                          className="border-t border-[var(--border)]"
                        >
                          <td className="px-2 py-1 text-[var(--fg)]">
                            {s.skillName ?? s.skillId ?? "（无技能）"}
                          </td>
                          <td className="px-2 py-1 text-[var(--fg-muted)]">{s.total}</td>
                          <td className="px-2 py-1 text-[var(--fg-muted)]">
                            {pct(s.successRate) ?? "—"}
                          </td>
                          <td className="px-2 py-1 text-[var(--fg-muted)]">
                            {fmtMs(s.avgCompletionMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-[13px] text-[var(--fg-muted)]">
                  {t("studio.overview.empty.skill_threads")}
                </div>
              )}

              {/* S1（11-P2-2）：自动匹配命中统计（skills.matched 事件聚合） */}
              <h3 className="mb-2 mt-4 text-[14px] font-medium text-[var(--fg)]">
                {t("studio.overview.skill_matches")}
              </h3>
              {skillMatches && skillMatches.length > 0 ? (
                <table className="w-full text-[13px]">
                  <thead className="text-[var(--fg-subtle)]">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">技能</th>
                      <th className="px-2 py-1 text-left font-medium">命中次数</th>
                      <th className="px-2 py-1 text-left font-medium">最近命中</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillMatches.map((s, idx) => (
                      <tr key={`${s.skillId}-${idx}`} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1 text-[var(--fg)]">{s.skillName}</td>
                        <td className="px-2 py-1 text-[var(--fg-muted)]">{s.matchCount}</td>
                        <td className="px-2 py-1 text-[var(--fg-muted)]">
                          {s.lastMatchedAt ? new Date(s.lastMatchedAt).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-[13px] text-[var(--fg-muted)]">
                  {t("studio.overview.empty.skill_matches")}
                </div>
              )}
            </section>
          </div>
        </section>
      )}

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
