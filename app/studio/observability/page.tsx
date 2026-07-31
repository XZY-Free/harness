import { StudioGatePage } from "@/components/studio/gate-page";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * V11 统一管理后台 — 观测与评测页（S11-W01 占位）。
 *
 * 一级导航「观测与评测」展示 Event、Trace、Observation、Evaluation、实验和告警。
 * S11-W05/W06 将填充 Trace/Observation 与 Evaluation 内容。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md
 *   「观测与评测」：Event、Trace、Observation、Evaluation、实验和告警
 */
export const dynamic = "force-dynamic";

export default async function ObservabilityPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">观测与评测</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        结构化 Trace、Observation、EvaluationRun、实验配置和告警入口。
      </p>
      <div className="mt-6 rounded-[var(--radius-md)] border border-dashed border-[var(--border)] bg-[var(--surface)]/50 p-6 text-center">
        <p className="text-[13px] text-[var(--fg-subtle)]">
          S11-W05 将在此页接入 Trace 树与 Observation；S11-W06 将在此页接入 Evaluation 评测。
        </p>
      </div>
    </div>
  );
}
