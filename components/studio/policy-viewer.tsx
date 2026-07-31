/**
 * Phase 4-4 Stage E：policy 配置只读展示。
 * 渲染 PolicyConfig 四块（protectedPaths / commandDenyList / formatOnWrite / verifyBeforeDelivery）。
 * 只读——本轮不做编辑 UI（留后续切片）。
 */

type Row = { key: string; value: unknown };

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-2 text-[14px] font-medium text-[var(--fg)]">{title}</h2>
      {children}
    </section>
  );
}

export function PolicyViewer({ rows }: { rows: Row[] }) {
  const byKey = new Map<string, unknown>();
  for (const r of rows) byKey.set(r.key, r.value);

  const protectedPaths = asStringArray(byKey.get("protectedPaths"));
  const commandDenyList = asStringArray(byKey.get("commandDenyList"));
  const formatOnWrite = asObject(byKey.get("formatOnWrite"));
  const verify = asObject(byKey.get("verifyBeforeDelivery"));

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Block title="受保护路径（protectedPaths）">
        {protectedPaths.length === 0 ? (
          <div className="text-[13px] text-[var(--fg-muted)]">—</div>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-[12px] text-[var(--fg-muted)]">
            {protectedPaths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="高危命令黑名单（commandDenyList）">
        {commandDenyList.length === 0 ? (
          <div className="text-[13px] text-[var(--fg-muted)]">—</div>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-[12px] text-[var(--fg-muted)]">
            {commandDenyList.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="写后格式化（formatOnWrite）">
        <dl className="text-[13px] text-[var(--fg-muted)]">
          <div className="flex gap-2">
            <dt className="w-24">enabled</dt>
            <dd>{String(formatOnWrite.enabled)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24">command</dt>
            <dd className="font-mono text-[12px]">{String(formatOnWrite.command ?? "")}</dd>
          </div>
        </dl>
      </Block>

      <Block title="交付前验证（verifyBeforeDelivery）">
        <dl className="text-[13px] text-[var(--fg-muted)]">
          <div className="flex gap-2">
            <dt className="w-28">enabled</dt>
            <dd>{String(verify.enabled)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28">command</dt>
            <dd className="font-mono text-[12px]">{String(verify.command ?? "")}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28">timeoutMs</dt>
            <dd>{String(verify.timeoutMs)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28">timeoutIsFailure</dt>
            <dd>{String(verify.timeoutIsFailure)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28">testFilePattern</dt>
            <dd className="font-mono text-[12px]">{String(verify.testFilePattern ?? "")}</dd>
          </div>
        </dl>
      </Block>
    </div>
  );
}
