import { SUMMARY_TYPE_LABELS } from "@/lib/context/summary-types";
import type { ContextSnapshot, ContextSummary } from "@/lib/db/schema";

/**
 * V3.0 Stage E：context manifest 只读面板。
 * 展示 thread 最近 context snapshot（来源清单 + 估算 token + 可见工具）。
 * 无 snapshot 时显示空状态。不展示完整 manifest JSON，避免噪音。
 *
 * V3.3a Stage E：扩展展示压缩版本历史（ContextSummary 列表 + 压缩比 + supersede 链）。
 */

type LayerEntry = {
  layer: string;
  sourceId: string;
  reason?: string;
  estimatedTokens?: number;
  inline?: string;
};

function layersOf(snap: ContextSnapshot): LayerEntry[] {
  const raw = snap.layers;
  if (!Array.isArray(raw)) return [];
  return raw as LayerEntry[];
}

export function ContextManifestPanel({
  snapshots,
  summaries,
}: {
  snapshots: ContextSnapshot[];
  summaries?: ContextSummary[];
}) {
  const hasSummaries = (summaries ?? []).length > 0;
  if (snapshots.length === 0 && !hasSummaries) {
    return (
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px] text-[var(--fg-muted)]">
        当前会话尚无上下文快照。每次模型调用前会自动记录一条。
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {hasSummaries && <ContextSummariesSection summaries={summaries ?? []} />}
      {snapshots.map((snap) => {
        const layers = layersOf(snap);
        const toolNames = Array.isArray(snap.toolNames) ? (snap.toolNames as string[]) : [];
        return (
          <div
            key={snap.id}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px]"
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[var(--fg-muted)]">
              <span className="font-medium text-[var(--fg)]">
                {new Date(snap.createdAt).toLocaleString()}
              </span>
              <span>模型 {snap.model}</span>
              <span>runtime {snap.runtimeType ?? "—"}</span>
              <span>skill {snap.activeSkillVersionId ?? "—"}</span>
              <span>估算 {snap.estimatedTokens} tokens</span>
              <span>工具 {toolNames.length}</span>
            </div>
            <div className="mt-3 overflow-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)]">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="text-left text-[var(--fg-subtle)]">
                    <th className="px-2 py-1 font-medium">层</th>
                    <th className="px-2 py-1 font-medium">来源</th>
                    <th className="px-2 py-1 font-medium">原因</th>
                    <th className="px-2 py-1 font-medium">tokens</th>
                    <th className="px-2 py-1 font-medium">摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {layers.map((l, i) => (
                    <tr key={`${l.sourceId}-${i}`} className="border-t border-[var(--border)]">
                      <td className="px-2 py-1 text-[var(--primary)]">{l.layer}</td>
                      <td className="px-2 py-1 font-mono text-[var(--fg)]">{l.sourceId}</td>
                      <td className="px-2 py-1 text-[var(--fg-muted)]">{l.reason ?? "—"}</td>
                      <td className="px-2 py-1 text-[var(--fg-muted)]">{l.estimatedTokens ?? 0}</td>
                      <td className="px-2 py-1 text-[var(--fg-subtle)]">{l.inline ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <SkillResolverEvidenceSection snap={snap} />
            {toolNames.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {toolNames.map((n) => (
                  <span
                    key={n}
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-muted)]"
                  >
                    {n}
                  </span>
                ))}
              </div>
            )}
            {Array.isArray(snap.excludedCandidates) &&
              (
                snap.excludedCandidates as Array<{
                  kind: string;
                  reason: string;
                  memoryId?: string;
                }>
              ).length > 0 && (
                <div className="mt-2 text-[12px] text-[var(--fg-muted)]">
                  <span className="font-medium">被裁候选:</span>
                  {(
                    snap.excludedCandidates as Array<{
                      kind: string;
                      reason: string;
                      memoryId?: string;
                    }>
                  ).map((c, i) => (
                    <span
                      key={`${c.kind}-${i}`}
                      className="ml-2 rounded border border-[var(--border)] px-1"
                    >
                      {c.kind}: {c.reason}
                    </span>
                  ))}
                </div>
              )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * V8：Skill Resolver 决策与加载证据区块。
 * 展示本轮 Resolver 输入摘要（availableSkillCount / uiSelectedSkillIds）、
 * 输出（selectedSkillVersions / decisionReason / ignored）和 readSkillFile 加载证据。
 * 无证据字段时（历史快照）不渲染。
 */
type ResolverInput = {
  availableSkillCount?: number;
  uiSelectedSkillIds?: string[];
};
type ResolverOutput = {
  selectedSkillVersions?: Array<{
    skillId: string;
    skillVersionId: string;
    role: string;
    source: string;
  }>;
  decisionReason?: string;
  ignoredUiSelectedSkillIds?: string[];
};
type LoadEvidenceEntry = {
  path: string;
  contentHash: string | null;
  truncated: boolean;
  skillVersionId: string;
  readAt: string;
};

function SkillResolverEvidenceSection({ snap }: { snap: ContextSnapshot }) {
  const resolverInput = snap.skillResolverInput as ResolverInput | null;
  const resolverOutput = snap.skillResolverOutput as ResolverOutput | null;
  const loadEvidence = Array.isArray(snap.skillLoadEvidence)
    ? (snap.skillLoadEvidence as LoadEvidenceEntry[])
    : null;
  if (!resolverInput && !resolverOutput && !loadEvidence) return null;

  return (
    <div className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[12px]">
      <div className="mb-2 font-medium text-[var(--fg)]">Skill Resolver 决策与加载证据</div>
      {resolverInput && (
        <div className="mb-2 text-[var(--fg-muted)]">
          <span className="font-medium">输入:</span> 候选 {resolverInput.availableSkillCount ?? "?"}{" "}
          个
          {resolverInput.uiSelectedSkillIds && resolverInput.uiSelectedSkillIds.length > 0 && (
            <span> · UI 选择 {resolverInput.uiSelectedSkillIds.join(", ")}</span>
          )}
        </div>
      )}
      {resolverOutput && (
        <div className="mb-2">
          <div className="text-[var(--fg-muted)]">
            <span className="font-medium">输出:</span> {resolverOutput.decisionReason ?? "—"}
          </div>
          {resolverOutput.selectedSkillVersions &&
            resolverOutput.selectedSkillVersions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {resolverOutput.selectedSkillVersions.map((v, i) => (
                  <span
                    key={`${v.skillVersionId}-${i}`}
                    className="rounded border border-[var(--border)] px-1 font-mono text-[11px] text-[var(--primary)]"
                  >
                    {v.role}/{v.source}: {v.skillVersionId.slice(0, 8)}
                  </span>
                ))}
              </div>
            )}
          {resolverOutput.ignoredUiSelectedSkillIds &&
            resolverOutput.ignoredUiSelectedSkillIds.length > 0 && (
              <div className="mt-1 text-[var(--fg-subtle)]">
                被忽略 UI 选择: {resolverOutput.ignoredUiSelectedSkillIds.join(", ")}
              </div>
            )}
        </div>
      )}
      {loadEvidence && loadEvidence.length > 0 && (
        <div className="mt-2">
          <div className="font-medium text-[var(--fg-muted)]">
            加载证据（{loadEvidence.length} 次读取）
          </div>
          <div className="mt-1 overflow-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="text-left text-[var(--fg-subtle)]">
                  <th className="px-1.5 py-0.5 font-medium">路径</th>
                  <th className="px-1.5 py-0.5 font-medium">hash</th>
                  <th className="px-1.5 py-0.5 font-medium">版本</th>
                  <th className="px-1.5 py-0.5 font-medium">时间</th>
                </tr>
              </thead>
              <tbody>
                {loadEvidence.map((e, i) => (
                  <tr key={`${e.path}-${i}`} className="border-t border-[var(--border)]">
                    <td className="px-1.5 py-0.5 font-mono text-[var(--fg)]">{e.path}</td>
                    <td className="px-1.5 py-0.5 font-mono text-[var(--fg-subtle)]">
                      {e.contentHash ?? "—"}
                    </td>
                    <td className="px-1.5 py-0.5 font-mono text-[var(--fg-subtle)]">
                      {e.skillVersionId ? e.skillVersionId.slice(0, 8) : "—"}
                    </td>
                    <td className="px-1.5 py-0.5 text-[var(--fg-subtle)]">
                      {e.readAt ? new Date(e.readAt).toLocaleTimeString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * V3.3a Stage E：压缩版本历史区块。
 * 展示每条 ContextSummary 的类型 / 压缩比 / supersede 状态 / 摘要正文。
 * supersede 链：isSuperseded=true 的行标记「已被取代 → supersededById」。
 */
function ContextSummariesSection({ summaries }: { summaries: ContextSummary[] }) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px]">
      <div className="mb-2 font-medium text-[var(--fg)]">压缩版本历史（ContextSummary）</div>
      <div className="overflow-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)]">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[var(--fg-subtle)]">
              <th className="px-2 py-1 font-medium">时间</th>
              <th className="px-2 py-1 font-medium">类型</th>
              <th className="px-2 py-1 font-medium">压缩比</th>
              <th className="px-2 py-1 font-medium">tokens</th>
              <th className="px-2 py-1 font-medium">状态</th>
              <th className="px-2 py-1 font-medium">摘要</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => {
              const label =
                SUMMARY_TYPE_LABELS[s.type as keyof typeof SUMMARY_TYPE_LABELS] ?? s.type;
              const created = new Date(s.createdAt);
              const isSuperseded = s.supersededById !== null;
              const ratio =
                s.originalTokenEstimate > 0
                  ? Number((s.tokenEstimate / s.originalTokenEstimate).toFixed(3))
                  : null;
              return (
                <tr key={s.id} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1 text-[var(--fg-muted)]">
                    {Number.isNaN(created.getTime()) ? "—" : created.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-[var(--primary)]">{label}</td>
                  <td className="px-2 py-1 text-[var(--fg-muted)]">
                    {ratio !== null ? `${ratio}×` : "—"}
                  </td>
                  <td className="px-2 py-1 text-[var(--fg-muted)]">
                    {s.tokenEstimate}/{s.originalTokenEstimate}
                  </td>
                  <td className="px-2 py-1 text-[var(--fg-muted)]">
                    {isSuperseded ? (
                      <span title={`已被 ${s.supersededById ?? ""} 取代`}>已取代</span>
                    ) : (
                      "活跃"
                    )}
                  </td>
                  <td className="max-w-[28rem] truncate px-2 py-1 text-[var(--fg-subtle)]">
                    {s.summaryText}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
