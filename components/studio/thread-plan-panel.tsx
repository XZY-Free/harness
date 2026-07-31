import type { ThreadPlan, ThreadPlanItem } from "@/lib/db/schema";
import { planItemStatusLabel } from "@/lib/i18n";

/**
 * V3.0 Stage E：plan/todo 只读面板。
 * 展示 thread 当前 active plan 与 items（按 position）。无 plan 时显示空状态。
 * V3.0 不暴露 agent 自动写计划的工具，文案明确「尚未创建结构化计划」。
 *
 * S1（12-P1-6）：item 状态标签收敛到 lib/i18n 的 PLAN_ITEM_STATUS_LABEL。
 */

function itemTone(status: string): string {
  if (status === "completed") return "text-[var(--ok)]";
  if (status === "failed" || status === "cancelled") return "text-[var(--danger)]";
  if (status === "in_progress") return "text-[var(--primary)]";
  return "text-[var(--fg-muted)]";
}

export function ThreadPlanPanel({
  plan,
  items,
}: {
  plan: ThreadPlan | null;
  items: ThreadPlanItem[];
}) {
  if (!plan) {
    return (
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px] text-[var(--fg-muted)]">
        当前会话尚未创建结构化计划。
      </div>
    );
  }
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium text-[var(--fg)]">{plan.title}</span>
        <span className="text-[var(--fg-muted)]">状态 {plan.status}</span>
        <span className="text-[var(--fg-subtle)]">来源 {plan.source}</span>
        <span className="text-[var(--fg-subtle)]">
          创建 {new Date(plan.createdAt).toLocaleString()}
        </span>
        <span className="text-[var(--fg-subtle)]">
          更新 {new Date(plan.updatedAt).toLocaleString()}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="mt-3 text-[var(--fg-muted)]">该计划暂无条目。</div>
      ) : (
        <ol className="mt-3 flex flex-col gap-1.5">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-start gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
            >
              <span className="w-8 shrink-0 text-[var(--fg-subtle)]">#{it.position}</span>
              <span className="flex-1 text-[var(--fg)]">{it.title}</span>
              <span className={`shrink-0 text-[12px] ${itemTone(it.status)}`}>
                {planItemStatusLabel(it.status)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
