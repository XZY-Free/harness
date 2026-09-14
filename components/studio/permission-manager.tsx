"use client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api-fetch";
import { PERMISSION_DIRECTORY } from "@/lib/identity/permission-directory";
import type { PermissionManagementView } from "@/lib/identity/permission-management";
import { useId, useState } from "react";
import { PermissionSubjectPicker } from "./permission-subject-picker";

type Role = PermissionManagementView["roles"][number];
type Group = PermissionManagementView["groups"][number];
const panel = "rounded-2xl border border-border bg-card p-5 space-y-4";
export function PermissionManager({
  initial,
  currentUserId,
}: { initial: PermissionManagementView; currentUserId: string }) {
  const prefix = useId();
  const [view, setView] = useState(initial);
  const [defaultMode, setDefaultMode] = useState(initial.defaults.mode);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(initial.users[0]?.principalId ?? "");
  const [draftRoles, setDraftRoles] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [roleEdit, setRoleEdit] = useState<Role | null>(null);
  const [groupEdit, setGroupEdit] = useState<Group | null>(null);
  const [explain, setExplain] = useState(false);
  const [checkAction, setCheckAction] = useState("agent.invoke");
  const [resourceId, setResourceId] = useState(initial.agents[0]?.id ?? "");
  const [decision, setDecision] = useState("");
  const selectedUser = view.users.find((u) => u.principalId === selected);
  const directRoles = view.assignments
    .filter((a) => a.principalId === selected && a.source === "local")
    .map((a) => a.roleKey);
  const inherited = view.assignments.filter(
    (a) =>
      a.principalId !== selected &&
      view.groups.some(
        (g) => g.principalId === a.principalId && g.memberIds.includes(selectedUser?.id ?? ""),
      ),
  );
  const chosen = draftRoles ?? directRoles;
  async function mutate(command: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await apiFetch("/studio/api/settings/permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "保存失败");
      const reload = await apiFetch("/studio/api/settings/permissions");
      const fresh = await reload.json();
      if (!reload.ok) throw new Error("已保存，但重新读取失败，请刷新页面");
      setView(fresh.data);
      setDraftRoles(null);
      setMessage("已保存，新的请求立即按最新权限校验。");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    setDecision("正在检查…");
    try {
      const item = PERMISSION_DIRECTORY.find((p) => p.code === checkAction);
      if (!item) throw new Error("请选择有效操作");
      const type = item.scopeTypes.includes("agent")
        ? "agent"
        : item.scopeTypes.includes("self")
          ? "self"
          : "tenant";
      const targetId =
        type === "tenant" ? view.tenantId : type === "self" ? selectedUser?.id : resourceId;
      const response = await apiFetch("/studio/api/settings/permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "explain",
          userId: selectedUser?.id,
          actionCode: checkAction,
          resource: { type, id: targetId || null },
        }),
      });
      const body = await response.json();
      setDecision(
        response.ok
          ? `${body.data.allowed ? "允许" : "拒绝"}：${body.data.reason}${body.data.sources.length ? `（${body.data.sources.join("、")}）` : ""}`
          : (body.error?.message ?? "检查失败"),
      );
    } catch {
      setDecision("检查失败，请重试");
    }
  }
  return (
    <section aria-label="成员与权限管理" className="space-y-4">
      <p className="text-sm text-muted-foreground">
        有效成员默认可以聊天并使用发布给自己的资产。后台角色与资产使用范围分别管理。
      </p>
      {message && (
        <output className="block rounded-lg bg-muted px-3 py-2 text-sm">{message}</output>
      )}
      <details className="rounded-2xl border bg-card p-5">
        <summary className="cursor-pointer text-sm font-medium">平台默认使用范围</summary>
        <div className="space-y-4 pt-4">
          <p className="text-sm text-muted-foreground">
            有效员工默认可以聊天、管理自己的会话。以下设置只影响继承平台默认范围的已发布智能体。
          </p>
          <Select
            value={defaultMode}
            onValueChange={(value) => {
              if (value) setDefaultMode(value);
            }}
          >
            <SelectTrigger aria-label="默认资产使用范围">
              <SelectValue>
                {defaultMode === "all" ? "全体员工可用" : "配置使用范围后可用"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全体员工可用</SelectItem>
              <SelectItem value="restricted">配置使用范围后可用</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            本次保存影响 {view.defaults.inheritedAssets.length} 个继承默认范围的智能体：
            {view.defaults.inheritedAssets.map((a) => a.name).join("、") || "无"}
            。显式配置的使用范围保持不变。
          </p>
          <Button
            disabled={busy || defaultMode === view.defaults.mode}
            onClick={() =>
              mutate({
                operation: "save_defaults",
                mode: defaultMode,
                version: view.defaults.version,
              })
            }
          >
            保存默认范围
          </Button>
        </div>
      </details>
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">成员</TabsTrigger>
          <TabsTrigger value="groups">用户组</TabsTrigger>
          <TabsTrigger value="roles">角色</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="pt-4">
          <div className="grid overflow-hidden rounded-2xl border bg-card lg:grid-cols-[16rem_1fr]">
            <div className="space-y-3 border-b p-4 lg:border-r lg:border-b-0">
              <Input
                aria-label="搜索成员"
                placeholder="搜索成员"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="max-h-96 space-y-1 overflow-auto">
                {view.users
                  .filter((u) =>
                    `${u.displayName ?? ""} ${u.email}`.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((u) => (
                    <Button
                      key={u.id}
                      variant={selected === u.principalId ? "secondary" : "ghost"}
                      className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                      onClick={() => {
                        setSelected(u.principalId ?? "");
                        setDraftRoles(null);
                      }}
                    >
                      {u.displayName ?? u.email}
                      {u.id === currentUserId ? "（我）" : ""}
                    </Button>
                  ))}
              </div>
            </div>
            <div className="space-y-5 p-5">
              {selectedUser ? (
                <>
                  <div>
                    <h3 className="font-medium">
                      {selectedUser.displayName ?? selectedUser.email}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {selectedUser.status === "active" ? "普通员工 · 默认" : "已停用"} ·{" "}
                      {selectedUser.email}
                    </p>
                  </div>
                  <fieldset className="space-y-3" disabled={busy}>
                    <legend className="mb-3 text-sm font-medium">本地后台角色</legend>
                    {view.roles
                      .filter((r) => r.key !== "member")
                      .map((r) => (
                        <div key={r.key} className="flex items-center gap-3 text-sm">
                          <Checkbox
                            id={`${prefix}-member-${r.key}`}
                            checked={chosen.includes(r.key)}
                            onCheckedChange={(checked) =>
                              setDraftRoles(
                                checked ? [...chosen, r.key] : chosen.filter((k) => k !== r.key),
                              )
                            }
                          />
                          <label htmlFor={`${prefix}-member-${r.key}`}>{r.name}</label>
                        </div>
                      ))}
                  </fieldset>
                  <p className="text-sm text-muted-foreground">
                    组继承：
                    {inherited
                      .map((a) => view.roles.find((r) => r.key === a.roleKey)?.name ?? a.roleKey)
                      .join("、") || "无"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    所属组：
                    {view.groups
                      .filter((g) => g.memberIds.includes(selectedUser.id))
                      .map((g) => g.name)
                      .join("、") || "无"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy || draftRoles === null}
                      onClick={() =>
                        mutate({
                          operation: "set_roles",
                          principalId: selected,
                          roleKeys: chosen,
                          expectedRoleKeys: directRoles,
                        })
                      }
                    >
                      保存角色
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setDecision("");
                        setExplain(true);
                      }}
                    >
                      检查权限
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">选择需要管理的成员</p>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="groups" className="space-y-4 pt-4">
          <Button
            variant="outline"
            onClick={() =>
              setGroupEdit({
                principalId: "",
                tenantId: "",
                name: "",
                source: "local",
                version: 0,
                memberIds: [],
              })
            }
          >
            新建用户组
          </Button>
          <div className="grid gap-4 md:grid-cols-2">
            {view.groups.map((g) => (
              <div className={panel} key={g.principalId}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{g.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {g.source === "local" ? "本地维护" : `企业同步 · ${g.source}`} ·{" "}
                      {g.memberIds.length} 位成员
                    </p>
                  </div>
                  <Button variant="ghost" onClick={() => setGroupEdit(g)}>
                    {g.source === "local" ? "管理" : "查看"}
                  </Button>
                </div>
                {
                  <details>
                    <summary className="cursor-pointer text-sm">后台角色</summary>
                    <div className="space-y-3 pt-3">
                      {view.roles
                        .filter((r) => r.key !== "member")
                        .map((r) => {
                          const assigned = view.assignments
                            .filter((a) => a.principalId === g.principalId && a.source === "local")
                            .map((a) => a.roleKey);
                          return (
                            <div key={r.key} className="flex items-center gap-3 text-sm">
                              <Checkbox
                                id={`${prefix}-${g.principalId}-${r.key}`}
                                disabled={busy}
                                checked={assigned.includes(r.key)}
                                onCheckedChange={(checked) =>
                                  mutate({
                                    operation: "set_roles",
                                    principalId: g.principalId,
                                    roleKeys: checked
                                      ? [...assigned, r.key]
                                      : assigned.filter((k) => k !== r.key),
                                    expectedRoleKeys: assigned,
                                  })
                                }
                              />
                              <label htmlFor={`${prefix}-${g.principalId}-${r.key}`}>
                                {r.name}
                              </label>
                            </div>
                          );
                        })}
                    </div>
                  </details>
                }
              </div>
            ))}
          </div>
          {!view.groups.length && (
            <p className="text-sm text-muted-foreground">
              暂无用户组。创建后可以在多个资产中复用。
            </p>
          )}
        </TabsContent>
        <TabsContent value="roles" className="space-y-4 pt-4">
          <Button
            variant="outline"
            onClick={() =>
              setRoleEdit({ key: "", name: "", isSystem: false, version: 0, grants: [] })
            }
          >
            新建角色
          </Button>
          <div className="grid gap-4 md:grid-cols-2">
            {view.roles.map((r) => (
              <div key={r.key} className={panel}>
                <div>
                  <h3 className="font-medium">{r.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {r.isSystem ? "内置角色" : "自定义角色"} ·{" "}
                    {new Set(r.grants.map((g) => g.actionCode)).size} 项能力
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setRoleEdit(r)}>
                    查看{!r.isSystem ? " / 编辑" : ""}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setRoleEdit({
                        ...r,
                        key: "",
                        name: `${r.name}副本`,
                        isSystem: false,
                        version: 0,
                      })
                    }
                  >
                    复制
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
      <Dialog
        open={!!roleEdit}
        onOpenChange={(open) => {
          if (!open) setRoleEdit(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{roleEdit?.isSystem ? "内置角色" : "编辑角色"}</DialogTitle>
            <DialogDescription>
              角色定义职责；指定资产的使用范围在资产详情中配置。
            </DialogDescription>
          </DialogHeader>
          {message && <output className="block text-sm">{message}</output>}
          {roleEdit && (
            <>
              <Input
                aria-label="角色名称"
                value={roleEdit.name}
                disabled={roleEdit.isSystem}
                onChange={(e) => setRoleEdit({ ...roleEdit, name: e.target.value })}
              />
              <div className="space-y-5">
                {[...new Set(PERMISSION_DIRECTORY.map((p) => p.domain))].map((domain) => (
                  <fieldset key={domain} disabled={roleEdit.isSystem || busy} className="space-y-2">
                    <legend className="mb-2 text-sm font-medium">{domain}</legend>
                    {PERMISSION_DIRECTORY.filter((p) => p.domain === domain).map((p) => (
                      <div className="flex items-center gap-3 text-sm" key={p.code}>
                        <Checkbox
                          id={`${prefix}-permission-${p.code}`}
                          checked={roleEdit.grants.some((g) => g.actionCode === p.code)}
                          onCheckedChange={(checked) =>
                            setRoleEdit({
                              ...roleEdit,
                              grants: checked
                                ? [
                                    ...roleEdit.grants,
                                    ...p.scopeTypes.map((type) => ({
                                      actionCode: p.code,
                                      resourceScope: { type, wildcard: true },
                                    })),
                                  ]
                                : roleEdit.grants.filter((g) => g.actionCode !== p.code),
                            })
                          }
                        />
                        <label htmlFor={`${prefix}-permission-${p.code}`} title={p.code}>
                          {p.label}
                          {roleEdit.grants
                            .filter((g) => g.actionCode === p.code)
                            .map((g, index) => (
                              <span
                                key={`${g.resourceScope.type}-${index}`}
                                className="block text-xs text-muted-foreground"
                              >
                                {g.resourceScope.type === "self"
                                  ? "仅本人"
                                  : g.resourceScope.wildcard
                                    ? "本租户内全部适用资源"
                                    : `指定资源：${g.resourceScope.ids?.join("、")}`}
                                {g.validFrom &&
                                  ` · 生效于 ${new Date(g.validFrom).toLocaleString()}`}
                                {g.validUntil &&
                                  ` · 到期于 ${new Date(g.validUntil).toLocaleString()}`}
                              </span>
                            ))}
                        </label>
                      </div>
                    ))}
                  </fieldset>
                ))}
              </div>
              {!roleEdit.isSystem && (
                <div className="flex gap-2">
                  <Button
                    disabled={busy || !roleEdit.name.trim()}
                    onClick={async () => {
                      if (
                        await mutate({
                          operation: "save_role",
                          id: roleEdit.key || undefined,
                          name: roleEdit.name,
                          version: roleEdit.version,
                          grants: roleEdit.grants,
                        })
                      )
                        setRoleEdit(null);
                    }}
                  >
                    保存角色
                  </Button>
                  {roleEdit.key && (
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={async () => {
                        if (
                          await mutate({
                            operation: "delete_role",
                            id: roleEdit.key,
                            version: roleEdit.version,
                          })
                        )
                          setRoleEdit(null);
                      }}
                    >
                      删除未使用角色
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!groupEdit}
        onOpenChange={(open) => {
          if (!open) setGroupEdit(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>用户组</DialogTitle>
            <DialogDescription>
              {groupEdit?.source === "local"
                ? "统一维护成员，资产通过用户组分配使用范围。"
                : "成员关系由企业资料提供，平台只读。"}
            </DialogDescription>
          </DialogHeader>
          {message && <output className="block text-sm">{message}</output>}
          {groupEdit && (
            <>
              <Input
                aria-label="用户组名称"
                value={groupEdit.name}
                disabled={groupEdit.source !== "local"}
                onChange={(e) => setGroupEdit({ ...groupEdit, name: e.target.value })}
              />
              <PermissionSubjectPicker
                label="组成员"
                options={view.users.map((u) => ({
                  id: u.id,
                  label: u.displayName ?? u.email,
                  description: u.email,
                }))}
                value={groupEdit.memberIds}
                disabled={groupEdit.source !== "local"}
                onChange={(memberIds) => setGroupEdit({ ...groupEdit, memberIds })}
              />
              {groupEdit.source === "local" && (
                <div className="flex gap-2">
                  <Button
                    disabled={busy || !groupEdit.name.trim()}
                    onClick={async () => {
                      if (
                        await mutate({
                          operation: "save_group",
                          id: groupEdit.principalId || undefined,
                          name: groupEdit.name,
                          memberIds: groupEdit.memberIds,
                          version: groupEdit.version,
                        })
                      )
                        setGroupEdit(null);
                    }}
                  >
                    保存用户组
                  </Button>
                  {groupEdit.principalId && (
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={async () => {
                        if (
                          await mutate({
                            operation: "delete_group",
                            id: groupEdit.principalId,
                            version: groupEdit.version,
                          })
                        )
                          setGroupEdit(null);
                      }}
                    >
                      删除未使用用户组
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={explain} onOpenChange={setExplain}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>检查成员权限</DialogTitle>
            <DialogDescription>
              使用与实际请求相同的规则，检查所选成员对具体资源的权限。
            </DialogDescription>
          </DialogHeader>
          <Select
            value={checkAction}
            onValueChange={(value) => {
              if (value) setCheckAction(value);
            }}
          >
            <SelectTrigger aria-label="检查的操作">
              <SelectValue>
                {PERMISSION_DIRECTORY.find((p) => p.code === checkAction)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_DIRECTORY.filter((p) =>
                [
                  "agent.invoke",
                  "agent.read",
                  "thread.read",
                  "thread.write",
                  "studio.access",
                  "user.manage",
                ].includes(p.code),
              ).map((p) => (
                <SelectItem key={p.code} value={p.code}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {checkAction.startsWith("agent.") && (
            <Select
              value={resourceId}
              onValueChange={(value) => {
                if (value) setResourceId(value);
              }}
            >
              <SelectTrigger aria-label="检查的智能体">
                <SelectValue>
                  {view.agents.find((a) => a.id === resourceId)?.name ?? "选择智能体"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {view.agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button onClick={inspect}>检查</Button>
          <output className="block text-sm">{decision}</output>
        </DialogContent>
      </Dialog>
    </section>
  );
}
