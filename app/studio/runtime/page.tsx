import { StudioGatePage } from "@/components/studio/gate-page";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * V11 统一管理后台 — Runtime 与环境页（S11-W01 占位）。
 *
 * 一级导航「Runtime 与环境」展示 RuntimeRevision、实例、Environment、Desktop、Workspace、
 * 健康和容量。S11-W02/W04 将填充 Runtime 发布治理与 Environment 排障内容。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md
 *   「Runtime 与环境」：RuntimeRevision、实例、Environment、Desktop、Workspace、健康和容量
 */
export const dynamic = "force-dynamic";

export default async function RuntimePage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">Runtime 与环境</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        RuntimeRevision 发布、Runtime 实例、Environment 与 Desktop 状态、Workspace 健康和容量。
      </p>
      <div className="mt-6 rounded-[var(--radius-md)] border border-dashed border-[var(--border)] bg-[var(--surface)]/50 p-6 text-center">
        <p className="text-[13px] text-[var(--fg-subtle)]">
          S11-W02 将在此页接入 RuntimeRevision 发布治理；S11-W04 将在此页接入 Environment 排障。
        </p>
      </div>
    </div>
  );
}
