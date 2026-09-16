"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
/**
 * AgentRevision 操作面板。
 *
 * 先从后端权威合同列表选择 exact Snapshot，再提交四个严格 JSON 对象；
 * 发布与撤回继续使用后端返回的 revision id / etag，并携带
 * Idempotency-Key / If-Match。界面只隐藏技术标识，不改变交接值。
 */
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentContractSnapshotDTO,
  type AgentRevisionSummaryDTO,
  ControlPlaneRequestError,
  type PublishAgentRevisionResponse,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

const POLICY_FIELDS = [
  { key: "model_policy", label: "模型策略", description: "约束模型选择、参数与调用范围。" },
  {
    key: "permission_requirements",
    label: "权限要求",
    description: "声明版本运行时需要的权限。",
  },
  { key: "delegation_policy", label: "委派策略", description: "约束任务委派与协作边界。" },
  {
    key: "agent_interface_requirements",
    label: "接口要求",
    description: "声明智能体对外接口的必要条件。",
  },
] as const;

const REVISION_STATE_LABEL: Record<AgentRevisionSummaryDTO["revision_state"], string> = {
  draft: "草稿",
  published: "已发布",
  withdrawn: "已撤回",
};

type PolicyKey = (typeof POLICY_FIELDS)[number]["key"];
type BusyAction = "create" | `publish:${string}` | `withdraw:${string}`;

function classifyError(err: unknown): string {
  if (err instanceof ControlPlaneRequestError) {
    switch (err.code) {
      case "REQUEST_SCHEMA_INVALID":
        return "请求内容不符合规范";
      case "ETAG_MISMATCH":
        return "内容已被他人修改，请刷新后重试";
      case "IDEMPOTENCY_CONFLICT":
        return "重复提交冲突，请重试";
      case "BUSINESS_CONSTRAINT_VIOLATION":
        return "业务约束拒绝（如发布前置条件未满足）";
      case "ACTION_SCOPE_DENIED":
        return "没有执行该操作的权限";
      default:
        return "操作失败，请稍后重试";
    }
  }
  return "操作失败，请稍后重试";
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface AgentRevisionActionsProps {
  readonly agentId: string;
  readonly guided?: boolean;
  readonly projectableFields?: readonly string[];
  readonly onContinue?: (revisionId: string) => void;
  /** 上游合同登记交接：合同列表真实存在该快照时自动选中，不生成假选项。 */
  readonly preferredSnapshotId?: string | null;
  /** 递增代次：上游变更后重新加载合同与版本列表。 */
  readonly refreshToken?: number;
  /** 发布成功回调；仅真实 publish API 成功后触发。 */
  readonly onPublished?: (result: PublishAgentRevisionResponse) => void;
}

export function AgentRevisionActions({
  agentId,
  guided = false,
  projectableFields = [],
  onContinue,
  preferredSnapshotId = null,
  refreshToken = 0,
  onPublished,
}: AgentRevisionActionsProps) {
  const formId = useId();
  const [editing, setEditing] = useState(false);
  const [snapshots, setSnapshots] = useState<AgentContractSnapshotDTO[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [policies, setPolicies] = useState<Record<PolicyKey, string>>({
    model_policy: "{}",
    permission_requirements: "{}",
    delegation_policy: "{}",
    agent_interface_requirements: "{}",
  });
  const [profileRequirement, setProfileRequirement] = useState("none");
  const [allowedFields, setAllowedFields] = useState<string[]>([]);
  const [confirmationKeys, setConfirmationKeys] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [revisions, setRevisions] = useState<AgentRevisionSummaryDTO[] | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const createRequest = useRef<{ body: string; key: string } | null>(null);
  const publishRequests = useRef(new Map<string, string>());
  const pendingCreated = useRef<{ body: string; revision: AgentRevisionSummaryDTO } | null>(null);
  const [pendingWithdrawal, setPendingWithdrawal] = useState<AgentRevisionSummaryDTO | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是刷新代次信号，非直接引用
  const reload = useCallback(async () => {
    try {
      const [contracts, revisionList] = await Promise.all([
        client.agents.listContracts(agentId),
        client.agents.listRevisions(agentId),
      ]);
      setSnapshots(contracts.items);
      setRevisions(revisionList.items);
      // 人工选择仍在权威列表时保留；否则只接受权威列表中真实存在的 handoff。
      const ids = new Set(contracts.items.map((item) => item.snapshot_id));
      setSnapshotId((current) => {
        if (ids.has(current)) return current;
        return preferredSnapshotId && ids.has(preferredSnapshotId)
          ? preferredSnapshotId
          : guided && contracts.items.length > 0
            ? (contracts.items[0]?.snapshot_id ?? "")
            : "";
      });
    } catch (err) {
      setError(classifyError(err));
    }
  }, [agentId, refreshToken, preferredSnapshotId, guided]);

  useEffect(() => {
    setRevisions(null);
    setError(null);
    setNotice(null);
    void reload();
  }, [reload]);

  async function createRevision() {
    setError(null);
    setNotice(null);
    const body: Record<string, unknown> = { agent_contract_snapshot_id: snapshotId };
    for (const field of POLICY_FIELDS) {
      const parsed = parseJsonObject(policies[field.key]);
      if (!parsed) {
        setError(`${field.label}必须是 JSON 对象`);
        return;
      }
      body[field.key] = parsed;
    }
    if (guided) {
      if (profileRequirement !== "none" && allowedFields.length === 0) {
        setError("请选择允许发送的身份字段。");
        return;
      }
      const keys = confirmationKeys.split(/[\s,，]+/).filter(Boolean);
      if (keys.some((key) => !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(key))) {
        setError("确认动作标识只能包含字母、数字、点、冒号、短横线或下划线。");
        return;
      }
      body.agent_interface_requirements = {
        ...(profileRequirement !== "none"
          ? {
              enterprise_user_context: {
                profile_requirement: profileRequirement,
                allowed_fields: allowedFields,
              },
            }
          : {}),
        ...(keys.length ? { host_controls: { confirmation_action_keys: [...new Set(keys)] } } : {}),
      };
    }
    setBusyAction("create");
    try {
      const bodyKey = JSON.stringify(body);
      if (createRequest.current?.body !== bodyKey)
        createRequest.current = { body: bodyKey, key: crypto.randomUUID() };
      const created =
        guided && pendingCreated.current?.body === bodyKey
          ? pendingCreated.current.revision
          : await client.agents.createRevision(
              agentId,
              {
                agent_contract_snapshot_id: body.agent_contract_snapshot_id as string,
                model_policy: body.model_policy as Record<string, unknown>,
                permission_requirements: body.permission_requirements as Record<string, unknown>,
                delegation_policy: body.delegation_policy as Record<string, unknown>,
                agent_interface_requirements: body.agent_interface_requirements as Record<
                  string,
                  unknown
                >,
              },
              { idempotencyKey: createRequest.current.key },
            );
      pendingCreated.current = { body: bodyKey, revision: created };
      setNotice(`已创建草稿版本（第 ${created.revision_no} 版）`);
      if (guided) await publish(created);
      await reload();
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function publish(revision: AgentRevisionSummaryDTO) {
    setError(null);
    setNotice(null);
    setBusyAction(`publish:${revision.id}`);
    try {
      const requestKey = JSON.stringify([revision.id, revision.etag, releaseNotes.trim()]);
      let idempotencyKey = publishRequests.current.get(requestKey);
      if (!idempotencyKey) {
        idempotencyKey = crypto.randomUUID();
        publishRequests.current.set(requestKey, idempotencyKey);
      }
      const result = await client.agents.publishRevision(
        revision.id,
        { release_notes: releaseNotes.trim() || "Studio 发布" },
        { idempotencyKey, ifMatch: revision.etag },
      );
      // 在 reload 前交接真实响应，避免发布成功而刷新失败时丢失发布事件。
      onPublished?.(result);
      setNotice(`版本 ${revision.revision_no} 已发布`);
      await reload();
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function withdraw(revision: AgentRevisionSummaryDTO) {
    setError(null);
    setNotice(null);
    setBusyAction(`withdraw:${revision.id}`);
    try {
      await client.agents.withdrawRevision(
        revision.id,
        { reason_code: "studio_withdraw", reason: "Studio 撤回" },
        { idempotencyKey: crypto.randomUUID(), ifMatch: revision.etag },
      );
      setNotice(`版本 ${revision.revision_no} 已撤回`);
      await reload();
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusyAction(null);
    }
  }

  const busy = busyAction !== null;
  const selectedSnapshot = snapshots.find((snapshot) => snapshot.snapshot_id === snapshotId);
  const requiresIdentity =
    selectedSnapshot?.invocation_context.some(
      (context) => context.key === "enterprise_user_context" && context.necessity === "required",
    ) ?? false;
  const supportsConfirmation =
    selectedSnapshot?.interaction.input_required && selectedSnapshot?.interaction.resume;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 更换合同后重新确认字段授权
  useEffect(() => {
    if (guided) {
      setProfileRequirement(requiresIdentity ? "fresh_required" : "none");
      setAllowedFields([]);
      setConfirmationKeys("");
    }
  }, [snapshotId, requiresIdentity, guided]);
  const published = revisions?.find((revision) => revision.revision_state === "published");
  const fieldNames: Record<string, string> = {
    employeeNo: "员工编号",
    departmentCode: "部门编号",
    buCode: "业务单元",
    factoryCode: "工厂编号",
    jobLevel: "职级",
  };

  if (guided && published && !editing)
    return (
      <section className="space-y-6" aria-label="已保存的使用设置">
        <div>
          <h3 className="text-base font-medium">使用设置已保存</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            当前保留第 {published.revision_no} 版设置。继续连接服务即可，不需要重新填写。
          </p>
        </div>
        <div className="rounded-lg bg-muted/30 p-5 text-sm leading-6">
          <p>员工资料授权和办理确认规则保存在使用设置中。</p>
          <a
            className="mt-2 inline-block underline underline-offset-4"
            href={`/studio/agents/${agentId}`}
          >
            查看当前设置详情
          </a>
        </div>
        <div className="flex flex-wrap gap-3">
          {onContinue && <Button onClick={() => onContinue(published.id)}>继续配置连接</Button>}
          <Button variant="outline" onClick={() => setEditing(true)}>
            创建新的使用设置
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          新设置从默认值开始，保存为另一版本；旧版本会保留。
        </p>
      </section>
    );

  return (
    <div className="space-y-5">
      <details open={!guided} className="space-y-2">
        <summary className="cursor-pointer text-sm text-muted-foreground">接入文件来源</summary>
        <label htmlFor={`${formId}-contract`} className="text-sm font-medium text-foreground">
          选择服务提供方交付的接入文件
        </label>
        <Select value={snapshotId || null} onValueChange={(value) => setSnapshotId(value ?? "")}>
          <SelectTrigger
            id={`${formId}-contract`}
            aria-label="选择服务提供方交付的接入文件"
            data-selected-id={snapshotId}
            className="w-full bg-background"
          >
            <SelectValue>
              {selectedSnapshot
                ? `合同版本 ${selectedSnapshot.contract_version} · ${new Date(selectedSnapshot.captured_at).toLocaleDateString("zh-CN")}`
                : "选择已登记合同"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {snapshots.map((snapshot, index) => (
              <SelectItem key={snapshot.snapshot_id} value={snapshot.snapshot_id}>
                合同版本 {snapshot.contract_version} ·{" "}
                {new Date(snapshot.captured_at).toLocaleDateString("zh-CN")} · 记录 {index + 1}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {snapshots.length === 0 && revisions !== null && (
          <p className="text-xs text-muted-foreground">该智能体尚无可用合同，请先完成合同登记。</p>
        )}
      </details>

      {guided && (
        <div className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">允许使用哪些员工资料</legend>
            <p className="text-xs leading-5 text-muted-foreground">
              {requiresIdentity
                ? "这个服务需要识别当前员工。勾选它办理业务必须使用的资料，未勾选的资料不会提供。"
                : "这个服务不要求员工资料，平台不会额外提供。"}
            </p>
            <label htmlFor={`${formId}-profile-requirement`} className="block space-y-2">
              <span className="text-sm">员工资料更新方式</span>
              <Select
                value={profileRequirement}
                onValueChange={(value) => {
                  if (!value) return;
                  setProfileRequirement(value);
                  if (value === "none") setAllowedFields([]);
                }}
              >
                <SelectTrigger
                  id={`${formId}-profile-requirement`}
                  aria-label="员工资料更新方式"
                  disabled={!requiresIdentity}
                  className="w-full bg-background"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectItem value="none" disabled={requiresIdentity}>
                    不提供企业资料
                  </SelectItem>
                  <SelectItem value="stale_allowed">允许使用上次获取的资料</SelectItem>
                  <SelectItem value="fresh_required">每次使用前确认资料有效</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {profileRequirement !== "none" && (
              <div className="grid gap-2 sm:grid-cols-2">
                {projectableFields.map((key) => (
                  <label
                    key={key}
                    className="flex items-center gap-3 rounded-md border px-3 py-2.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={allowedFields.includes(key)}
                      onChange={(event) =>
                        setAllowedFields((current) =>
                          event.target.checked
                            ? [...current, key]
                            : current.filter((item) => item !== key),
                        )
                      }
                      className="size-4 accent-current"
                    />
                    {fieldNames[key] ?? key}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <details className="space-y-3 border-t pt-5">
            <summary className="cursor-pointer text-sm font-medium">
              办理确认规则（服务提供方设置）
            </summary>
            <p className="text-xs leading-5 text-muted-foreground">
              {supportsConfirmation
                ? "用于防止未经员工确认就提交业务。请向服务提供方索取规则标识；不要自行编写或根据名称猜测。多个标识用逗号分隔。"
                : "该服务暂不支持由平台设置办理确认。"}
            </p>
            <label htmlFor={`${formId}-confirmations`} className="block space-y-2">
              <span className="text-sm">需要确认的动作标识</span>
              <Textarea
                disabled={!supportsConfirmation}
                id={`${formId}-confirmations`}
                aria-label="需要确认的动作标识"
                value={confirmationKeys}
                onChange={(event) => setConfirmationKeys(event.target.value)}
                rows={2}
                placeholder="粘贴服务提供方给出的确认规则标识"
              />
            </label>
          </details>
          <label htmlFor={`${formId}-release-notes`} className="block space-y-2 border-t pt-5">
            <span className="text-sm">本次设置备注（选填）</span>
            <Textarea
              value={releaseNotes}
              onChange={(event) => setReleaseNotes(event.target.value)}
              id={`${formId}-release-notes`}
              aria-label="版本说明"
              rows={2}
              placeholder="说明这次接入或配置的变化"
            />
          </label>
        </div>
      )}
      <details open={!guided} className="group rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          技术设置（一般无需修改）
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            模型、权限与委派策略
          </span>
        </summary>
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {POLICY_FIELDS.filter(
            (field) => !guided || field.key !== "agent_interface_requirements",
          ).map((field) => {
            const inputId = `${formId}-${field.key}`;
            return (
              <div key={field.key} className="rounded-xl border bg-muted/20 p-3">
                <label htmlFor={inputId} className="text-sm font-medium text-foreground">
                  {field.label}
                </label>
                <p className="mt-0.5 text-xs text-muted-foreground">{field.description}</p>
                <Textarea
                  id={inputId}
                  value={policies[field.key]}
                  onChange={(event) =>
                    setPolicies((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  rows={5}
                  spellCheck={false}
                  aria-label={field.label}
                  className="mt-3 min-h-28 resize-y bg-background font-mono text-xs"
                />
              </div>
            );
          })}
        </div>
      </details>

      <Button type="button" disabled={!snapshotId || busy} onClick={createRevision}>
        {busyAction === "create" && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
        {busy ? "保存中…" : guided ? "保存配置并继续" : "创建草稿版本"}
      </Button>

      {(!guided || (revisions && revisions.length > 0)) && (
        <details open={!guided} className="space-y-2">
          <summary className="cursor-pointer text-sm font-medium">版本记录</summary>
          {revisions === null && !error && (
            <output
              aria-live="polite"
              className="flex items-center gap-2 rounded-xl border px-4 py-6 text-sm text-muted-foreground"
            >
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              正在加载版本记录…
            </output>
          )}
          {revisions?.length === 0 && (
            <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              暂无版本记录
            </div>
          )}
          {revisions && revisions.length > 0 && (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="min-w-[520px] w-full text-sm">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium">版本</th>
                    <th className="px-4 py-3 text-left text-xs font-medium">状态</th>
                    <th className="px-4 py-3 text-right text-xs font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {revisions.map((revision) => (
                    <tr key={revision.id} className="border-t first:border-t-0">
                      <td className="px-4 py-3 font-medium text-foreground">
                        第 {revision.revision_no} 版
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground">
                          {REVISION_STATE_LABEL[revision.revision_state]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {revision.revision_state === "draft" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => publish(revision)}
                          >
                            {busyAction === `publish:${revision.id}` && (
                              <LoaderCircle className="size-4 animate-spin" aria-hidden />
                            )}
                            {busyAction === `publish:${revision.id}` ? "发布中…" : "发布"}
                          </Button>
                        )}
                        {revision.revision_state === "published" && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={busy}
                            onClick={() => setPendingWithdrawal(revision)}
                          >
                            {busyAction === `withdraw:${revision.id}` && (
                              <LoaderCircle className="size-4 animate-spin" aria-hidden />
                            )}
                            {busyAction === `withdraw:${revision.id}` ? "撤回中…" : "撤回"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </div>
      )}
      {notice && (
        <output
          aria-live="polite"
          className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-foreground"
        >
          <CheckCircle2 className="size-4 text-success" aria-hidden />
          {notice}
        </output>
      )}

      <AlertDialog
        open={pendingWithdrawal !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingWithdrawal(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              确认撤回第 {pendingWithdrawal?.revision_no ?? "—"} 版？
            </AlertDialogTitle>
            <AlertDialogDescription>
              撤回后，该版本不能再用于新的员工会话；已有记录仍会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                const revision = pendingWithdrawal;
                if (!revision) return;
                await withdraw(revision);
                setPendingWithdrawal(null);
              }}
            >
              {busy ? "撤回中…" : "确认撤回"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
