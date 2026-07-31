/**
 * Phase 4-4 Stage C：指标卡片（数字 + 标签 + 子计数），不引入图表库。
 * 纯展示，server / client 均可用。
 */
export function MetricCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string | number | null;
  sub?: string;
  tone?: "default" | "ok" | "danger" | "accent";
}) {
  const toneClass =
    tone === "ok"
      ? "text-[var(--ok)]"
      : tone === "danger"
        ? "text-[var(--danger)]"
        : tone === "accent"
          ? "text-[var(--primary)]"
          : "text-[var(--fg)]";
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 transition-shadow hover:shadow-sm">
      <div className="text-[13px] leading-relaxed text-[var(--fg-subtle)]">{label}</div>
      <div className={`mt-1.5 text-[22px] font-semibold tracking-tight ${toneClass}`}>
        {value === null ? "—" : value}
      </div>
      {sub && <div className="mt-1 text-[12px] leading-relaxed text-[var(--fg-muted)]">{sub}</div>}
    </div>
  );
}

/** 百分比格式化：null → null（卡片显示 —）。 */
export function pct(rate: number | null): string | null {
  if (rate === null) return null;
  return `${(rate * 100).toFixed(1)}%`;
}
