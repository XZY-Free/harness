"use client";

/**
 * AgentRevision 操作入口：选择 Agent 后渲染 AgentRevisionActions（07 §6）。
 */
import { AgentRevisionActions } from "@/components/studio/agent-revision-actions";
import { createControlPlaneClient } from "@/lib/control-plane-client";
import { useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

export function AgentsRevisionSection() {
  const [agents, setAgents] = useState<Array<{ id: string; display_name: string }>>([]);
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.agents
      .list()
      .then((list) =>
        setAgents(list.items.map((a) => ({ id: a.id, display_name: a.display_name }))),
      )
      .catch(() => setError("Agent 列表加载失败"));
  }, []);

  if (error) return <div className="text-[13px] text-[var(--danger)]">{error}</div>;

  return (
    <div className="space-y-3">
      <label className="block text-[12px] text-[var(--fg-muted)]">
        Agent
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          aria-label="agent"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[13px] text-[var(--fg)]"
        >
          <option value="">（选择 Agent）</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.display_name}
            </option>
          ))}
        </select>
      </label>
      {agentId && <AgentRevisionActions agentId={agentId} />}
    </div>
  );
}
