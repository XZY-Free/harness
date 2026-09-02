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
  type AgentRevisionSummaryDTO,
  ControlPlaneRequestError,
  type PublishAgentRevisionResponse,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

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
  /** 上游合同登记交接：合同列表真实存在该快照时自动选中，不生成假选项。 */
  readonly preferredSnapshotId?: string | null;
  /** 递增代次：上游变更后重新加载合同与版本列表。 */
  readonly refreshToken?: number;
  /** 发布成功回调；仅真实 publish API 成功后触发。 */
  readonly onPublished?: (result: PublishAgentRevisionResponse) => void;
}

export function AgentRevisionActions({
  agentId,
  preferredSnapshotId = null,
  refreshToken = 0,
  onPublished,
}: AgentRevisionActionsProps) {
  const formId = useId();
  const [snapshots, setSnapshots] = useState<
    Array<{ snapshot_id: string; contract_version: string; captured_at: string }>
  >([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [policies, setPolicies] = useState<Record<PolicyKey, string>>({
    model_policy: "{}",
    permission_requirements: "{}",
    delegation_policy: "{}",
    agent_interface_requirements: "{}",
  });
  const [revisions, setRevisions] = useState<AgentRevisionSummaryDTO[] | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingWithdrawal, setPendingWithdrawal] = useState<AgentRevisionSummaryDTO | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是刷新代次信号，非直接引用
  const reload = useCallback(async () => {
    try {
      const [contracts, revisionList] = await Promise.all([
        client.agents.listContracts(agentId),
        client.agents.listRevisions(agentId),
      ]);
      setSnapshots(
        contracts.items.map((item) => ({
          snapshot_id: item.snapshot_id,
          contract_version: item.contract_version,
          captured_at: item.captured_at,
        })),
      );
      setRevisions(revisionList.items);
      // 人工选择仍在权威列表时保留；否则只接受权威列表中真实存在的 handoff。
      const ids = new Set(contracts.items.map((item) => item.snapshot_id));
      setSnapshotId((current) => {
        if (ids.has(current)) return current;
        return preferredSnapshotId && ids.has(preferredSnapshotId) ? preferredSnapshotId : "";
      });
    } catch (err) {
      setError(classifyError(err));
    }
  }, [agentId, refreshToken, preferredSnapshotId]);

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
    setBusyAction("create");
    try {
      const created = await client.agents.createRevision(
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
        { idempotencyKey: crypto.randomUUID() },
      );
      setNotice(`已创建草稿版本（第 ${created.revision_no} 版）`);
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
      const result = await client.agents.publishRevision(
        revision.id,
        { release_notes: "Studio 发布" },
        { idempotencyKey: crypto.randomUUID(), ifMatch: revision.etag },
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

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label htmlFor={`${formId}-contract`} className="text-sm font-medium text-foreground">
          创建版本使用的合同
        </label>
        <Select value={snapshotId || null} onValueChange={(value) => setSnapshotId(value ?? "")}>
          <SelectTrigger
            id={`${formId}-contract`}
            aria-label="创建版本使用的合同"
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
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {POLICY_FIELDS.map((field) => {
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

      <Button type="button" disabled={!snapshotId || busy} onClick={createRevision}>
        {busyAction === "create" && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
        {busyAction === "create" ? "创建中…" : "创建草稿版本"}
      </Button>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">版本记录</h3>
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
      </div>

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
