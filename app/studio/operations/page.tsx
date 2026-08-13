import { StudioGatePage } from "@/components/studio/gate-page";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * 统一管理后台 — 运营页（S11-W01 占位）。
 *
 * 一级导航「运营」展示使用量、成本、队列、配额、失败与服务水平。
 * S11-W07 将填充 cost/capacity 投影表 + 聚合 + 告警内容。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *   「运营」：使用量、成本、队列、配额、失败与服务水平
 */
export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">运营</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        使用量、成本、容量、队列、配额、失败率与服务水平（SLA）。 告警从可执行阈值产生，可跳转相关
        Invocation/Event/Trace。
      </p>
      <div className="mt-6 rounded-[var(--radius-md)] border border-dashed border-[var(--border)] bg-[var(--surface)]/50 p-6 text-center">
        <p className="text-[13px] text-[var(--fg-subtle)]">
          S11-W07 将在此页接入成本容量投影与告警。
        </p>
      </div>
    </div>
  );
}
