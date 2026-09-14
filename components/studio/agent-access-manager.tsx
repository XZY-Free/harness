"use client";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-fetch";
import { useEffect, useState } from "react";
import { type PermissionSubjectOption, PermissionSubjectPicker } from "./permission-subject-picker";
interface AccessPolicy {
  mode: string;
  principals: string[];
  collaborators: Array<{ principalId: string; actions: string[] }>;
  version: number;
}
export function AgentAccessManager({ agentId }: { agentId: string }) {
  const [defaultMode, setDefaultMode] = useState("all");
  const [policy, setPolicy] = useState<AccessPolicy | null>(null);
  const [subjects, setSubjects] = useState<PermissionSubjectOption[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/studio/api/agents/${agentId}/access`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? "读取失败");
        if (!cancelled) {
          setPolicy(body.data.policy);
          setDefaultMode(body.data.defaultMode);
          setSubjects(body.data.subjects);
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  async function save() {
    if (!policy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await apiFetch(`/studio/api/agents/${agentId}/access`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policy),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "保存失败");
      setPolicy({ ...policy, version: body.data.version });
      setMessage("已保存，新的智能体调用按最新范围校验。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby="agent-access-title"
      className="space-y-5 rounded-2xl border bg-card p-5"
    >
      <div>
        <h2 id="agent-access-title" className="text-lg font-semibold">
          访问管理
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          使用范围控制谁能调用；协作权限控制谁能编辑和发布。智能体仍须启用并完成发布。
        </p>
      </div>
      {message && <output className="block text-sm">{message}</output>}
      {policy ? (
        <>
          <fieldset disabled={busy} className="space-y-3">
            <legend className="mb-3 text-sm font-medium">使用范围</legend>
            {[
              {
                value: "inherit",
                label: `继承平台默认（${defaultMode === "all" ? "全体员工" : "配置范围后可用"}）`,
              },
              { value: "all", label: "全体成员" },
              { value: "restricted", label: "指定成员和用户组" },
              ...(policy.mode === "roles" ? [{ value: "roles", label: "按原有角色授权范围" }] : []),
            ].map((option) => (
              <label key={option.value} className="flex items-center gap-3 text-sm">
                <input
                  type="radio"
                  name={`access-${agentId}`}
                  value={option.value}
                  checked={policy.mode === option.value}
                  onChange={() => setPolicy({ ...policy, mode: option.value })}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          {policy.mode === "restricted" && (
            <>
              <PermissionSubjectPicker
                label="使用成员"
                options={subjects}
                value={policy.principals}
                onChange={(principals) => setPolicy({ ...policy, principals })}
                disabled={busy}
              />
              {!policy.principals.length && (
                <p className="text-sm text-muted-foreground">
                  当前未选择任何成员；保存后员工将无法调用此智能体。
                </p>
              )}
            </>
          )}
          <details className="border-t pt-4">
            <summary className="cursor-pointer text-sm font-medium">协作管理</summary>
            <div className="grid gap-5 pt-4 md:grid-cols-2">
              {[
                { label: "编辑成员", actions: ["agent.read", "agent.revision.create"] },
                {
                  label: "发布负责人",
                  actions: ["agent.publish", "agent.retract", "route.update"],
                },
              ].map((group) => (
                <PermissionSubjectPicker
                  key={group.label}
                  label={group.label}
                  options={subjects}
                  disabled={busy}
                  value={policy.collaborators
                    .filter((c) => group.actions.every((action) => c.actions.includes(action)))
                    .map((c) => c.principalId)}
                  onChange={(selected) => {
                    const map = new Map(
                      policy.collaborators.map((c) => [
                        c.principalId,
                        c.actions.filter((a) => !group.actions.includes(a)),
                      ]),
                    );
                    for (const id of selected)
                      map.set(id, [...(map.get(id) ?? []), ...group.actions]);
                    setPolicy({
                      ...policy,
                      collaborators: [...map]
                        .filter(([, actions]) => actions.length)
                        .map(([principalId, actions]) => ({ principalId, actions })),
                    });
                  }}
                />
              ))}
            </div>
          </details>
          <Button disabled={busy} onClick={save}>
            {busy ? "正在保存…" : "保存访问设置"}
          </Button>
        </>
      ) : (
        !message && <p className="text-sm text-muted-foreground">正在读取访问设置…</p>
      )}
    </section>
  );
}
