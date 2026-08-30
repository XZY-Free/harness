"use client";

import { useMemo, useState } from "react";

/**
 * Settings 用户/角色管理 client UI（关口02 02-2c grant 化适配）。
 *
 * - 左侧用户列表（当前用户标记）。
 * - 右侧选中用户的角色模板 checkbox（来自系统角色模板集合）+ 各模板 action 只读展示。
 * - 保存调用 PUT /studio/api/settings/users/[id]/roles（覆盖语义，roleIds = 模板 key）。
 * - 自锁/最后管理员由服务端守卫；UI 展示返回的 error.message。
 *
 * 数据源与持久化走 grant：用户携带的 templateKeys 由服务端从 roleActionBinding 推导，
 * 保存时服务端把所选模板的 grant 并集物化为绑定。
 *
 * 不做用户创建/删除，不做角色模板创建/删除，不编辑权限。
 */

type SettingsUser = {
  id: string;
  email: string;
  displayName: string | null;
  externalSubject: string;
  templateKeys: string[];
};

type RoleTemplateView = {
  key: string;
  name: string;
  isSystem: boolean;
  actions: string[];
};

type Props = {
  currentUserId: string;
  users: SettingsUser[];
  roles: RoleTemplateView[];
};

/** Action Code → 中文标签（技术 key 作 title 悬浮提示保留）。 */
const PERMISSION_LABEL: Record<string, string> = {
  "studio.access": "后台访问",
  "skill.read": "技能读取",
  "skill.write": "技能写入",
  "thread.read": "会话读取",
  "thread.write": "会话写入",
  "policy.read": "策略读取",
  "policy.write": "策略写入",
  "user.manage": "用户管理",
  "agent.read": "智能体读取",
  "agent.invoke": "智能体调用",
  "workspace.read": "工作区读取",
  "workspace.write": "工作区写入",
  "analytics.read": "数据分析",
  "audit.read": "审计读取",
};

/** Action Code 列表 → 中文标签列表（未知 key 原样回退）。 */
function permissionLabels(keys: string[]): string[] {
  return keys.map((k) => PERMISSION_LABEL[k] ?? k);
}

export function SettingsUserRoleManager({ currentUserId, users, roles }: Props) {
  const [visibleUsers, setVisibleUsers] = useState(users);
  const [selectedId, setSelectedId] = useState<string>(users[0]?.id ?? "");
  // 编辑态：userId → 选中的角色模板 key 集合
  const [draft, setDraft] = useState<Record<string, Set<string>>>(() => {
    const init: Record<string, Set<string>> = {};
    for (const u of users) init[u.id] = new Set(u.templateKeys);
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // 模板 key → 模板（名称 + action 只读展示）
  const roleByKey = useMemo(() => {
    const m = new Map<string, RoleTemplateView>();
    for (const r of roles) m.set(r.key, r);
    return m;
  }, [roles]);

  const selected = visibleUsers.find((u) => u.id === selectedId) ?? null;

  function selectUser(id: string) {
    setSelectedId(id);
    setMessage(null);
  }

  function toggleRole(key: string) {
    if (!selected) return;
    setMessage(null);
    setDraft((prev) => {
      const next = new Set(prev[selected.id]);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [selected.id]: next };
    });
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    setMessage(null);
    try {
      const roleIds = [...(draft[selected.id] ?? [])];
      const res = await fetch(`/studio/api/settings/users/${selected.id}/roles`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleIds }),
      });
      const body = await res.json();
      if (res.ok) {
        const savedRoleIds = Array.isArray(body?.data?.roleIds) ? body.data.roleIds : roleIds;
        setDraft((prev) => ({ ...prev, [selected.id]: new Set(savedRoleIds) }));
        setVisibleUsers((prev) =>
          prev.map((u) => (u.id === selected.id ? { ...u, templateKeys: savedRoleIds } : u)),
        );
        setMessage({ kind: "ok", text: "已保存" });
      } else {
        setMessage({
          kind: "error",
          text: body?.error?.message ?? "保存失败",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "网络错误" });
    } finally {
      setSaving(false);
    }
  }

  if (visibleUsers.length === 0) {
    return (
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 text-[13px] text-[var(--fg-muted)]">
        暂无用户。
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[260px_1fr]">
      {/* 用户列表 */}
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] font-medium text-[var(--fg-subtle)]">
          用户
        </div>
        <ul className="max-h-[480px] overflow-auto">
          {visibleUsers.map((u) => {
            const active = u.id === selectedId;
            const isSelf = u.id === currentUserId;
            return (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => selectUser(u.id)}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2 text-left text-[13px] transition ${
                    active
                      ? "bg-[var(--accent-soft)] text-[var(--primary)]"
                      : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
                  }`}
                >
                  <span className="font-medium">
                    {u.displayName ?? u.email}
                    {isSelf && (
                      <span className="ml-2 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--fg-subtle)]">
                        当前用户
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--fg-subtle)]">{u.email}</span>
                  <span className="text-[11px] text-[var(--fg-subtle)]">
                    {u.templateKeys.map((k) => roleByKey.get(k)?.name ?? k).join(", ") || "无角色"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* 角色模板编辑 */}
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        {selected ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[15px] font-medium text-[var(--fg)]">
                  {selected.displayName ?? selected.email}
                  {selected.id === currentUserId && (
                    <span className="ml-2 text-[12px] text-[var(--fg-subtle)]">当前用户</span>
                  )}
                </div>
                <div className="font-mono text-[12px] text-[var(--fg-subtle)]">
                  {selected.email}
                </div>
              </div>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-[var(--radius-sm)] bg-[var(--primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--accent-fg)] transition hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>

            {message && (
              <div
                className={`mt-3 rounded-[var(--radius-sm)] px-3 py-2 text-[13px] ${
                  message.kind === "ok"
                    ? "bg-[var(--accent-soft)] text-[var(--primary)]"
                    : "bg-[var(--danger-soft)] text-[var(--danger)]"
                }`}
              >
                {message.text}
              </div>
            )}

            <div className="mt-4">
              <h3 className="mb-2 text-[13px] font-medium text-[var(--fg)]">角色模板</h3>
              <div className="flex flex-col gap-2">
                {roles.map((r) => {
                  const checked = draft[selected.id]?.has(r.key) ?? false;
                  return (
                    <label
                      key={r.key}
                      className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-2 text-[13px] hover:bg-[var(--surface-2)]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRole(r.key)}
                        className="mt-0.5"
                      />
                      <span className="flex-1">
                        <span className="font-medium text-[var(--fg)]">{r.name}</span>
                        <span className="ml-2 font-mono text-[11px] text-[var(--fg-subtle)]">
                          {r.key}
                          {r.isSystem ? " · 内置" : ""}
                        </span>
                        <span
                          className="mt-1 block text-[11px] text-[var(--fg-subtle)]"
                          title={r.actions.join(", ")}
                        >
                          {permissionLabels(r.actions).join("、") || "无权限"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <div className="text-[13px] text-[var(--fg-muted)]">选择左侧用户。</div>
        )}
      </div>
    </div>
  );
}
