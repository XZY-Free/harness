"use client";

import { Check, Save, ShieldCheck, UserRound } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

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
      <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        <UserRound className="mx-auto mb-3 size-5" aria-hidden="true" />
        暂无用户。
      </div>
    );
  }

  return (
    <section
      aria-label="成员角色管理"
      data-slot="studio-settings-group"
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs"
    >
      <div className="grid lg:grid-cols-[14rem_1fr]">
        <div className="border-b border-border lg:border-r lg:border-b-0">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-medium text-foreground">用户</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">选择需要配置角色的成员</p>
          </div>
          <ul className="max-h-80 overflow-auto p-1.5 lg:max-h-[30rem]">
            {visibleUsers.map((u) => {
              const active = u.id === selectedId;
              const isSelf = u.id === currentUserId;
              return (
                <li key={u.id} className="py-0.5">
                  <Button
                    variant="ghost"
                    onClick={() => selectUser(u.id)}
                    aria-pressed={active}
                    className={cn(
                      "h-auto w-full items-start justify-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left",
                      active && "bg-accent text-accent-foreground hover:bg-accent",
                    )}
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <UserRound className="size-3.5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 font-medium text-foreground">
                        <span className="truncate">{u.displayName ?? u.email}</span>
                        {isSelf && (
                          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                            我
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                        {u.email}
                      </span>
                      <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
                        {u.templateKeys.map((k) => roleByKey.get(k)?.name ?? k).join("、") ||
                          "无角色"}
                      </span>
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="min-w-0">
          {selected ? (
            <>
              <div className="flex flex-col gap-4 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-base font-semibold text-foreground">
                      {selected.displayName ?? selected.email}
                    </h3>
                    {selected.id === currentUserId && (
                      <span className="shrink-0 text-xs text-muted-foreground">当前用户</span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">{selected.email}</p>
                </div>
                <Button onClick={save} disabled={saving} className="self-start sm:self-auto">
                  <Save aria-hidden="true" />
                  {saving ? "保存中…" : "保存角色"}
                </Button>
              </div>

              {message && (
                <div
                  role={message.kind === "ok" ? "status" : "alert"}
                  className={cn(
                    "mx-5 mt-4 flex items-center gap-2 rounded-xl px-3 py-2 text-sm",
                    message.kind === "ok"
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "bg-destructive/10 text-destructive",
                  )}
                >
                  {message.kind === "ok" && <Check className="size-4" aria-hidden="true" />}
                  {message.text}
                </div>
              )}

              <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-medium text-foreground">
                <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
                角色权限
              </div>
              <div>
                {roles.map((r) => {
                  const checked = draft[selected.id]?.has(r.key) ?? false;
                  return (
                    <div
                      key={r.key}
                      data-slot="studio-settings-row"
                      className="flex items-start gap-3 border-b border-border px-5 py-3.5 transition-colors last:border-b-0 hover:bg-muted/50 focus-within:bg-muted/50"
                    >
                      <Checkbox
                        id={`role-${r.key}`}
                        checked={checked}
                        onCheckedChange={() => toggleRole(r.key)}
                        aria-label={r.name}
                        className="mt-0.5"
                      />
                      <label htmlFor={`role-${r.key}`} className="flex-1 cursor-pointer">
                        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                          {r.name}
                          {r.isSystem && (
                            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                              内置
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          {permissionLabels(r.actions).join("、") || "无权限"}
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">选择一名用户。</div>
          )}
        </div>
      </div>
    </section>
  );
}
