"use client";

/**
 * Permission Rules 编辑器（关口02 02-6 · 冻结方案 §30 / §31 / §33 / §P3）。
 *
 * client 组件：管理 Tool 执行策略规则（ruleKey / toolPattern / argMatcher / decision /
 * scope / priority / reason）。保存调 PUT /studio/api/permission-rules，携带
 * If-Match = 当前 versionNo（ETag 乐观锁，§33），发布一个全新 Policy Revision。
 * - 412 → 并发冲突，提示刷新（绝不最后写入覆盖他人刚发布的 Revision）。
 * - 成功 → 从响应 ETag 头更新本地 versionNo，展示新 revisionNo。
 * - 正式决策值仅 allow / pause / block（§P3）。
 */
import { useState } from "react";

interface RuleRow {
  id: string;
  ruleKey: string;
  toolPattern: string;
  argMatcher: Record<string, string> | null;
  decision: "allow" | "pause" | "block";
  scope: { type: string; ref?: string };
  priority: number;
  reason: string | null;
}

interface Props {
  initialDefaultDecision: "allow" | "pause" | "block";
  initialRules: RuleRow[];
  initialVersionNo: number;
  canWrite: boolean;
  revisionNo: number;
  publishedAt: string | null;
}

function newRow(index: number): RuleRow {
  return {
    id: `__new_${index}_${Math.random()}`,
    ruleKey: `rule-${Date.now()}-${index}`,
    toolPattern: "tool.*",
    argMatcher: null,
    decision: "pause",
    scope: { type: "tenant" },
    priority: 0,
    reason: null,
  };
}

export function PermissionRulesEditor({
  initialDefaultDecision,
  initialRules,
  initialVersionNo,
  canWrite,
  revisionNo,
  publishedAt,
}: Props) {
  const [defaultDecision, setDefaultDecision] = useState(initialDefaultDecision);
  const [rules, setRules] = useState<RuleRow[]>(initialRules);
  const [versionNo, setVersionNo] = useState(initialVersionNo);
  const [savedRevisionNo, setSavedRevisionNo] = useState(revisionNo);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!canWrite) {
    return (
      <div className="rounded border border-[var(--border)] p-4 text-[13px]">
        <Meta
          defaultDecision={initialDefaultDecision}
          revisionNo={savedRevisionNo}
          publishedAt={publishedAt}
        />
        {initialRules.length === 0 ? (
          <p className="mt-2 text-[var(--fg-muted)]">
            （无规则；默认决策 pause，全部 Tool 均暂停）
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-[var(--fg-muted)]">
                  <Th>ruleKey</Th>
                  <Th>toolPattern</Th>
                  <Th>decision</Th>
                  <Th>priority</Th>
                  <Th>reason</Th>
                </tr>
              </thead>
              <tbody>
                {initialRules.map((row) => (
                  <tr key={row.id} className="border-t border-[var(--border)]">
                    <Td mono>{row.ruleKey}</Td>
                    <Td mono>{row.toolPattern}</Td>
                    <Td>{row.decision}</Td>
                    <Td>{row.priority}</Td>
                    <Td>{row.reason ?? ""}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  function updateRule(index: number, patch: Partial<RuleRow>) {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/studio/api/permission-rules", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(versionNo),
        },
        body: JSON.stringify({
          defaultDecision,
          rules: rules.map((r) => ({
            ruleKey: r.ruleKey,
            toolPattern: r.toolPattern,
            argMatcher: r.argMatcher,
            decision: r.decision,
            scope: r.scope,
            priority: r.priority,
            reason: r.reason,
          })),
        }),
      });
      if (res.status === 412) {
        setError("并发冲突：其他管理员刚发布了新策略。请刷新后重试（不覆盖他人修订）。");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(`保存失败（${res.status}）：${data?.error ?? "未知错误"}`);
        return;
      }
      const data = await res.json();
      const nextEtag = res.headers.get("etag");
      if (nextEtag) {
        const n = Number(nextEtag);
        if (Number.isInteger(n)) setVersionNo(n);
      }
      setSavedRevisionNo(data.revision?.revisionNo ?? savedRevisionNo);
      setNotice(`已发布 revision ${data.revision?.revisionNo ?? ""}`);
    } catch {
      setError("网络错误，保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-[var(--border)] p-4 text-[13px]">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          默认决策（无匹配规则时）
          <select
            value={defaultDecision}
            onChange={(e) => setDefaultDecision(e.target.value as "allow" | "pause" | "block")}
            className="rounded border border-[var(--border)] bg-transparent p-1"
          >
            <option value="allow">allow</option>
            <option value="pause">pause</option>
            <option value="block">block</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => setRules((prev) => [...prev, newRow(prev.length)])}
          className="rounded border border-[var(--border)] px-2 py-1 text-[12px]"
        >
          + 新增规则
        </button>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[var(--fg-muted)]">
              <Th>ruleKey</Th>
              <Th>toolPattern</Th>
              <Th>decision</Th>
              <Th>priority</Th>
              <Th>reason</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rules.map((row, i) => (
              <tr key={row.id} className="border-t border-[var(--border)]">
                <Td>
                  <input
                    className="w-28 rounded border border-[var(--border)] bg-transparent p-1 font-mono text-[12px]"
                    value={row.ruleKey}
                    onChange={(e) => updateRule(i, { ruleKey: e.target.value })}
                  />
                </Td>
                <Td>
                  <input
                    className="w-28 rounded border border-[var(--border)] bg-transparent p-1 font-mono text-[12px]"
                    value={row.toolPattern}
                    onChange={(e) => updateRule(i, { toolPattern: e.target.value })}
                  />
                </Td>
                <Td>
                  <select
                    value={row.decision}
                    onChange={(e) =>
                      updateRule(i, { decision: e.target.value as RuleRow["decision"] })
                    }
                    className="rounded border border-[var(--border)] bg-transparent p-1"
                  >
                    <option value="allow">allow</option>
                    <option value="pause">pause</option>
                    <option value="block">block</option>
                  </select>
                </Td>
                <Td>
                  <input
                    type="number"
                    className="w-14 rounded border border-[var(--border)] bg-transparent p-1"
                    value={row.priority}
                    onChange={(e) => updateRule(i, { priority: Number(e.target.value) || 0 })}
                  />
                </Td>
                <Td>
                  <input
                    className="w-40 rounded border border-[var(--border)] bg-transparent p-1"
                    value={row.reason ?? ""}
                    onChange={(e) => updateRule(i, { reason: e.target.value || null })}
                  />
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
                    className="text-[var(--danger)]"
                  >
                    删除
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <div className="mt-3 text-[12px] text-[var(--danger)]">{error}</div>}
      {notice && <div className="mt-3 text-[12px] text-[var(--success)]">{notice}</div>}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
        >
          {saving ? "发布中…" : "发布新策略"}
        </button>
        <span className="text-[11px] text-[var(--fg-muted)]">ETag: {versionNo}</span>
      </div>
      <Meta
        defaultDecision={defaultDecision}
        revisionNo={savedRevisionNo}
        publishedAt={publishedAt}
      />
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-2 py-1 font-medium">{children}</th>;
}
function Td({ children, mono }: { children?: React.ReactNode; mono?: boolean }) {
  return <td className={`px-2 py-1 ${mono ? "font-mono" : ""}`}>{children}</td>;
}
function Meta({
  defaultDecision,
  revisionNo,
  publishedAt,
}: {
  defaultDecision: string;
  revisionNo: number;
  publishedAt: string | null;
}) {
  return (
    <div className="mt-3 text-[11px] text-[var(--fg-muted)]">
      默认决策：{defaultDecision} · 当前修订：rev {revisionNo}
      {publishedAt ? ` · 发布于 ${new Date(publishedAt).toLocaleString()}` : ""}
    </div>
  );
}
