"use client";

/**
 * AgentRevision 操作面板（07 §6）。
 *
 * 先选 exact Snapshot，再以四个严格 JSON editor 输入
 * model_policy / permission_requirements / delegation_policy /
 * agent_interface_requirements，调用 source-free Create Revision API；
 * 绝不出现 source type / Git commit / artifact ref / instruction hash / framework。
 * Publish / Withdraw 尊重 Idempotency-Key / If-Match（etag）。
 */
import {
  type AgentRevisionSummaryDTO,
  ControlPlaneRequestError,
  type PublishAgentRevisionResponse,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useCallback, useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

/** AgentRevisionSummaryDTO.etag 即 If-Match 值（正式端点合同）。 */
const POLICY_FIELDS = [
  { key: "model_policy", label: "model_policy" },
  { key: "permission_requirements", label: "permission_requirements" },
  { key: "delegation_policy", label: "delegation_policy" },
  { key: "agent_interface_requirements", label: "agent_interface_requirements" },
] as const;

type PolicyKey = (typeof POLICY_FIELDS)[number]["key"];

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
        return "无对应操作权限";
      default:
        return `操作失败（${err.code ?? "未知错误"}）`;
    }
  }
  return "操作失败";
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
  /** 发布成功回调（完整 PublishAgentRevisionResponse），发布动作仍由用户点击触发。 */
  readonly onPublished?: (result: PublishAgentRevisionResponse) => void;
}

export function AgentRevisionActions({
  agentId,
  preferredSnapshotId = null,
  refreshToken = 0,
  onPublished,
}: AgentRevisionActionsProps) {
  const [snapshots, setSnapshots] = useState<
    Array<{ snapshot_id: string; contract_version: string }>
  >([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [policies, setPolicies] = useState<Record<PolicyKey, string>>({
    model_policy: "{}",
    permission_requirements: "{}",
    delegation_policy: "{}",
    agent_interface_requirements: "{}",
  });
  const [revisions, setRevisions] = useState<AgentRevisionSummaryDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是刷新代次信号（合同登记后重载合同与版本列表），非直接引用
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
        })),
      );
      setRevisions(revisionList.items);
      // 保留仍在真实列表中的人工选择；当前选择已无效时才选择真实存在的 preferred；
      // 都不存在则清空，绝不设置不存在的值或生成假 option。
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
    // 不在此处清空 snapshotId：是否保留/清空由 reload 按真实列表统一判定，
    // 否则刷新代次变化会先把人工选择清掉。
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
        setError(`${field.label} 不是合法 JSON 对象`);
        return;
      }
      body[field.key] = parsed;
    }
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function publish(revision: AgentRevisionSummaryDTO) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await client.agents.publishRevision(
        revision.id,
        { release_notes: "Studio 发布（07 §6）" },
        { idempotencyKey: crypto.randomUUID(), ifMatch: revision.etag },
      );
      // 只用真实 publish API 返回的响应交接；在 reload 之前触发，
      // 避免发布已成功但列表刷新失败时丢失真实发布事件。
      onPublished?.(result);
      setNotice(`版本 ${revision.revision_no} 已发布`);
      await reload();
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(revision: AgentRevisionSummaryDTO) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await client.agents.withdrawRevision(
        revision.id,
        { reason_code: "studio_withdraw", reason: "Studio 撤回（07 §6）" },
        { idempotencyKey: crypto.randomUUID(), ifMatch: revision.etag },
      );
      setNotice(`版本 ${revision.revision_no} 已撤回`);
      await reload();
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-[13px] font-medium text-[var(--fg)]">智能体版本操作</div>

      <label className="block text-[12px] text-[var(--fg-muted)]">
        创建版本使用的合同
        <select
          value={snapshotId}
          onChange={(e) => setSnapshotId(e.target.value)}
          aria-label="创建版本使用的合同"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
        >
          <option value="">（选择合同）</option>
          {snapshots.map((snapshot) => (
            <option key={snapshot.snapshot_id} value={snapshot.snapshot_id}>
              {snapshot.snapshot_id}（{snapshot.contract_version}）
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {POLICY_FIELDS.map((field) => (
          <label key={field.key} className="text-[12px] text-[var(--fg-muted)]">
            {field.label}（严格 JSON）
            <textarea
              value={policies[field.key]}
              onChange={(e) => setPolicies((prev) => ({ ...prev, [field.key]: e.target.value }))}
              rows={4}
              spellCheck={false}
              aria-label={field.label}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 font-mono text-[12px] text-[var(--fg)]"
            />
          </label>
        ))}
      </div>

      <button
        type="button"
        disabled={!snapshotId || busy}
        onClick={createRevision}
        className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-50"
      >
        {busy ? "处理中…" : "创建草稿版本"}
      </button>

      {revisions && revisions.length > 0 && (
        <div className="overflow-hidden rounded border border-[var(--border)]">
          <table className="w-full text-[12px]">
            <thead className="bg-[var(--surface-2)] text-[var(--fg-subtle)]">
              <tr>
                <th className="px-2 py-1 text-left font-medium">版本</th>
                <th className="px-2 py-1 text-left font-medium">状态</th>
                <th className="px-2 py-1 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((revision) => (
                <tr key={revision.id} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1 font-mono text-[var(--fg-muted)]">
                    #{revision.revision_no}
                  </td>
                  <td className="px-2 py-1 text-[var(--fg-muted)]">{revision.revision_state}</td>
                  <td className="px-2 py-1">
                    {revision.revision_state === "draft" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => publish(revision)}
                        className="mr-2 rounded border border-[var(--border)] px-2 py-0.5 text-[var(--fg)] disabled:opacity-50"
                      >
                        发布
                      </button>
                    )}
                    {revision.revision_state === "published" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => withdraw(revision)}
                        className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--fg)] disabled:opacity-50"
                      >
                        撤回
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}
      {notice && <div className="text-[12px] text-[var(--fg)]">{notice}</div>}
    </div>
  );
}
