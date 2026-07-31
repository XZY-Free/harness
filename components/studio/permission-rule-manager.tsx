"use client";

import { Icon } from "@/components/icons";
import { useCallback, useEffect, useState } from "react";

/**
 * S1(07-P2-5):permission rule 管理器(client)。
 *
 * 接通 07-P2-5 审计死代码:写操作走 /studio/api/permission-rules(后端调 create/update/delete
 * 并同事务落审计),读审计历史走 /audit 子路由。
 *
 * 功能:规则列表(priority 降序)+ 新建表单 + 行内编辑/删除(二次确认)+ 审计历史折叠。
 * 仅 policy.write 可写(policies 页 server 侧已判定 canWrite,传入);无写权限只读列表。
 *
 * 设计沿用 PolicyEditor 令牌(--surface/--border/--fg-muted),不引新框架。
 */

type Decision = "allow" | "deny" | "ask";
type Scope = "global" | "tenant" | "project" | "thread" | "skill";
type ArgMatcher = { pathRegex?: string; commandRegex?: string; risk?: string } | null;

type Rule = {
  id: string;
  scope: Scope;
  scopeRef: string | null;
  toolPattern: string;
  argMatcher: ArgMatcher;
  decision: Decision;
  reason: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
};

type AuditLog = {
  id: string;
  actorUserId: string;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  targetId: string;
  outcome: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const DECISION_LABEL: Record<Decision, string> = {
  allow: "放行",
  deny: "拒绝",
  ask: "询问",
};
const DECISION_COLOR: Record<Decision, string> = {
  allow: "text-[var(--ok,#16a34a)]",
  deny: "text-[var(--danger,#dc2626)]",
  ask: "text-[var(--warn,#d97706)]",
};

function emptyDraft(): Omit<Rule, "id" | "createdAt" | "updatedAt"> {
  return {
    scope: "global",
    scopeRef: null,
    toolPattern: "",
    argMatcher: null,
    decision: "ask",
    reason: null,
    priority: 0,
  };
}

export function PermissionRuleManager({ canWrite }: { canWrite: boolean }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [pathRegex, setPathRegex] = useState("");
  const [commandRegex, setCommandRegex] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [showAudit, setShowAudit] = useState(false);

  const loadRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetch("/studio/api/permission-rules");
    const json = await res.json();
    if (!json.ok) {
      setError(json.error?.message ?? "加载失败");
    } else {
      setRules(json.data.rules);
    }
    setLoading(false);
  }, []);

  const loadAudit = useCallback(async () => {
    const res = await fetch("/studio/api/permission-rules/audit?limit=50");
    const json = await res.json();
    if (json.ok) setLogs(json.data.logs);
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  function buildArgMatcher(): ArgMatcher {
    const m: NonNullable<ArgMatcher> = {};
    if (pathRegex.trim()) m.pathRegex = pathRegex.trim();
    if (commandRegex.trim()) m.commandRegex = commandRegex.trim();
    return Object.keys(m).length > 0 ? m : null;
  }

  async function submitCreate() {
    setError(null);
    const body = {
      scope: draft.scope,
      scopeRef: draft.scope === "global" ? null : draft.scopeRef,
      toolPattern: draft.toolPattern,
      decision: draft.decision,
      argMatcher: buildArgMatcher(),
      reason: draft.reason,
      priority: draft.priority,
    };
    const res = await fetch("/studio/api/permission-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      setError(json.error?.message ?? "新建失败");
      return;
    }
    setDraft(emptyDraft());
    setPathRegex("");
    setCommandRegex("");
    await loadRules();
  }

  async function submitPatch(id: string) {
    setError(null);
    const body = {
      scope: draft.scope,
      scopeRef: draft.scope === "global" ? null : draft.scopeRef,
      toolPattern: draft.toolPattern,
      decision: draft.decision,
      argMatcher: buildArgMatcher(),
      reason: draft.reason,
      priority: draft.priority,
    };
    const res = await fetch(`/studio/api/permission-rules/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      setError(json.error?.message ?? "更新失败");
      return;
    }
    setEditingId(null);
    setDraft(emptyDraft());
    setPathRegex("");
    setCommandRegex("");
    await loadRules();
  }

  async function submitDelete(id: string) {
    setError(null);
    const res = await fetch(`/studio/api/permission-rules/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const json = await res.json();
    if (!json.ok) {
      setError(json.error?.message ?? "删除失败");
      return;
    }
    setConfirmDeleteId(null);
    await loadRules();
  }

  function startEdit(rule: Rule) {
    setEditingId(rule.id);
    setDraft({
      scope: rule.scope,
      scopeRef: rule.scopeRef,
      toolPattern: rule.toolPattern,
      argMatcher: rule.argMatcher,
      decision: rule.decision,
      reason: rule.reason,
      priority: rule.priority,
    });
    setPathRegex(rule.argMatcher?.pathRegex ?? "");
    setCommandRegex(rule.argMatcher?.commandRegex ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyDraft());
    setPathRegex("");
    setCommandRegex("");
  }

  async function toggleAudit() {
    const next = !showAudit;
    setShowAudit(next);
    if (next && logs.length === 0) await loadAudit();
  }

  const draftArgMatcher = buildArgMatcher();

  return (
    <section className="mt-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-medium text-[var(--fg)]">权限规则</h2>
          <p className="mt-1 text-[12px] text-[var(--fg-subtle)]">
            持久化 ask/deny/allow 规则(DB 覆盖默认规则)。写操作落审计,可追溯谁改/何时/改前值。
          </p>
        </div>
        <button
          type="button"
          onClick={toggleAudit}
          className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]"
        >
          <Icon.chevron size={12} />
          {showAudit ? "隐藏审计" : "变更审计"}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-[var(--radius-sm)] bg-[var(--danger-bg,rgba(220,38,38,0.08))] px-3 py-2 text-[12px] text-[var(--danger,#dc2626)]">
          {error}
        </p>
      )}

      {/* 规则列表 */}
      {loading ? (
        <p className="mt-3 text-[12px] text-[var(--fg-subtle)]">加载中…</p>
      ) : rules.length === 0 ? (
        <p className="mt-3 text-[12px] text-[var(--fg-subtle)]">暂无持久化规则(仅默认规则生效)。</p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--border)]">
          {rules.map((r) => (
            <li key={r.id} className="py-2">
              {editingId === r.id ? (
                <RuleForm
                  draft={draft}
                  setDraft={setDraft}
                  pathRegex={pathRegex}
                  setPathRegex={setPathRegex}
                  commandRegex={commandRegex}
                  setCommandRegex={setCommandRegex}
                  argMatcher={draftArgMatcher}
                  onCancel={cancelEdit}
                  onSubmit={() => submitPatch(r.id)}
                  submitLabel="保存"
                />
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-[13px] font-medium ${DECISION_COLOR[r.decision]}`}>
                        {DECISION_LABEL[r.decision]}
                      </span>
                      <code className="rounded bg-[var(--surface-hover)] px-1.5 py-0.5 text-[12px] text-[var(--fg)]">
                        {r.toolPattern}
                      </code>
                      <span className="text-[11px] text-[var(--fg-subtle)]">
                        {r.scope}
                        {r.scopeRef ? `:${r.scopeRef.slice(0, 8)}` : ""} · 优先级 {r.priority}
                      </span>
                    </div>
                    {r.argMatcher && (
                      <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">
                        {[
                          r.argMatcher.pathRegex && `path:${r.argMatcher.pathRegex}`,
                          r.argMatcher.commandRegex && `cmd:${r.argMatcher.commandRegex}`,
                        ]
                          .filter(Boolean)
                          .join(" / ")}
                      </p>
                    )}
                    {r.reason && (
                      <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">{r.reason}</p>
                    )}
                  </div>
                  {canWrite && (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(r)}
                        className="rounded px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]"
                      >
                        编辑
                      </button>
                      {confirmDeleteId === r.id ? (
                        <button
                          type="button"
                          onClick={() => submitDelete(r.id)}
                          className="rounded bg-[var(--danger,#dc2626)] px-2 py-1 text-[11px] text-white"
                        >
                          确认删除
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(r.id)}
                          className="rounded px-2 py-1 text-[11px] text-[var(--danger,#dc2626)] hover:bg-[var(--surface-hover)]"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 新建表单 */}
      {canWrite && editingId === null && (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <h3 className="mb-2 text-[13px] font-medium text-[var(--fg)]">新建规则</h3>
          <RuleForm
            draft={draft}
            setDraft={setDraft}
            pathRegex={pathRegex}
            setPathRegex={setPathRegex}
            commandRegex={commandRegex}
            setCommandRegex={setCommandRegex}
            argMatcher={draftArgMatcher}
            onSubmit={submitCreate}
            submitLabel="新建"
          />
        </div>
      )}

      {/* 审计历史 */}
      {showAudit && (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <h3 className="mb-2 text-[13px] font-medium text-[var(--fg)]">变更审计</h3>
          {logs.length === 0 ? (
            <p className="text-[12px] text-[var(--fg-subtle)]">暂无变更记录。</p>
          ) : (
            <ul className="space-y-1">
              {logs.map((log) => (
                <li key={log.id} className="text-[11px] text-[var(--fg-subtle)]">
                  <span className="text-[var(--fg-muted)]">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>{" "}
                  <code>{log.action}</code>{" "}
                  {log.actorName ?? log.actorEmail ?? log.actorUserId.slice(0, 8)}{" "}
                  <span
                    className={
                      log.outcome === "succeeded"
                        ? "text-[var(--ok,#16a34a)]"
                        : "text-[var(--danger,#dc2626)]"
                    }
                  >
                    {log.outcome}
                  </span>
                  {typeof log.metadata === "object" &&
                    log.metadata &&
                    "toolPattern" in log.metadata && (
                      <span>
                        {" "}
                        · {String((log.metadata as { toolPattern: unknown }).toolPattern)}
                      </span>
                    )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

type Draft = Omit<Rule, "id" | "createdAt" | "updatedAt">;

function RuleForm({
  draft,
  setDraft,
  pathRegex,
  setPathRegex,
  commandRegex,
  setCommandRegex,
  argMatcher,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  pathRegex: string;
  setPathRegex: (v: string) => void;
  commandRegex: string;
  setCommandRegex: (v: string) => void;
  argMatcher: ArgMatcher;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const isGlobal = draft.scope === "global";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <select
          value={draft.scope}
          onChange={(e) => setDraft({ ...draft, scope: e.target.value as Scope })}
          className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] text-[var(--fg)]"
        >
          <option value="global">global</option>
          <option value="project">project</option>
          <option value="thread">thread</option>
          <option value="skill">skill</option>
          <option value="tenant">tenant</option>
        </select>
        {!isGlobal && (
          <input
            placeholder={`${draft.scope} id`}
            value={draft.scopeRef ?? ""}
            onChange={(e) => setDraft({ ...draft, scopeRef: e.target.value })}
            className="min-w-[120px] flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] text-[var(--fg)]"
          />
        )}
        <input
          placeholder="toolPattern（如 tool.writeFile）"
          value={draft.toolPattern}
          onChange={(e) => setDraft({ ...draft, toolPattern: e.target.value })}
          className="min-w-[160px] flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] text-[var(--fg)]"
        />
        <select
          value={draft.decision}
          onChange={(e) => setDraft({ ...draft, decision: e.target.value as Decision })}
          className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] text-[var(--fg)]"
        >
          <option value="allow">放行</option>
          <option value="deny">拒绝</option>
          <option value="ask">询问</option>
        </select>
        <input
          type="number"
          placeholder="优先级"
          value={draft.priority}
          onChange={(e) =>
            setDraft({ ...draft, priority: Number.parseInt(e.target.value || "0", 10) })
          }
          className="w-20 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] text-[var(--fg)]"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          placeholder="pathRegex（可选,如 ^secrets/.*）"
          value={pathRegex}
          onChange={(e) => setPathRegex(e.target.value)}
          className="min-w-[160px] flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] text-[var(--fg)]"
        />
        <input
          placeholder="commandRegex（可选）"
          value={commandRegex}
          onChange={(e) => setCommandRegex(e.target.value)}
          className="min-w-[160px] flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] text-[var(--fg)]"
        />
      </div>
      <input
        placeholder="reason（可选）"
        value={draft.reason ?? ""}
        onChange={(e) => setDraft({ ...draft, reason: e.target.value || null })}
        className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] text-[var(--fg)]"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={!draft.toolPattern.trim()}
          className="rounded bg-[var(--primary)] px-3 py-1 text-[12px] text-white disabled:opacity-40"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--fg-muted)]"
          >
            取消
          </button>
        )}
      </div>
      {argMatcher && (
        <p className="text-[11px] text-[var(--fg-subtle)]">
          argMatcher:{" "}
          {[
            "pathRegex" in argMatcher && argMatcher.pathRegex && `path:${argMatcher.pathRegex}`,
            "commandRegex" in argMatcher &&
              argMatcher.commandRegex &&
              `cmd:${argMatcher.commandRegex}`,
          ]
            .filter(Boolean)
            .join(" / ") || "无约束"}
        </p>
      )}
    </div>
  );
}
