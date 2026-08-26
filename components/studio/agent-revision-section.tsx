"use client";

/**
 * AgentRevision 操作入口：选择 Agent 后渲染 AgentRevisionActions（07 §6）。
 */
import { AgentRevisionActions } from "@/components/studio/agent-revision-actions";
import { createControlPlaneClient } from "@/lib/control-plane-client";
import { useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

interface AgentsRevisionSectionProps {
  /** 上游合同登记交接：真实存在时自动选中该智能体。 */
  readonly preferredAgentId?: string | null;
  /** 上游合同登记交接：真实存在时由 AgentRevisionActions 选中该合同快照。 */
  readonly preferredSnapshotId?: string | null;
  /** 递增代次：上游变更后重新加载 Agent 列表。 */
  readonly refreshToken?: number;
}

export function AgentsRevisionSection({
  preferredAgentId = null,
  preferredSnapshotId = null,
  refreshToken = 0,
}: AgentsRevisionSectionProps) {
  const [agents, setAgents] = useState<Array<{ id: string; display_name: string }>>([]);
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是刷新代次信号（合同登记后重载列表），非直接引用
  useEffect(() => {
    let active = true;
    setError(null);
    client.agents
      .list()
      .then((list) => {
        if (!active) return;
        const items = list.items.map((a) => ({ id: a.id, display_name: a.display_name }));
        setAgents(items);
        const ids = new Set(items.map((a) => a.id));
        // preferred agent 真实存在则优先交接；否则保留仍在真实列表中的人工选择；
        // 两者都不在列表（如已被删除）时清空，绝不保留失效 id。
        setAgentId((current) => {
          if (preferredAgentId && ids.has(preferredAgentId)) return preferredAgentId;
          return ids.has(current) ? current : "";
        });
      })
      .catch(() => {
        if (active) setError("智能体列表加载失败");
      });
    return () => {
      active = false;
    };
  }, [refreshToken, preferredAgentId]);

  if (error) return <div className="text-[13px] text-[var(--danger)]">{error}</div>;

  return (
    <div className="space-y-3">
      <label className="block text-[12px] text-[var(--fg-muted)]">
        创建版本的智能体
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          aria-label="创建版本的智能体"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
        >
          <option value="">（选择智能体）</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.display_name}
            </option>
          ))}
        </select>
      </label>
      {agentId && (
        <AgentRevisionActions
          agentId={agentId}
          preferredSnapshotId={preferredSnapshotId}
          refreshToken={refreshToken}
        />
      )}
    </div>
  );
}
