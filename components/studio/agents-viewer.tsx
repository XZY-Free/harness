"use client";

import {
  type AgentDTO,
  ControlPlaneRequestError,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

const LIFECYCLE_LABEL: Record<AgentDTO["lifecycle_state"], string> = {
  draft: "草稿",
  enabled: "已启用",
  disabled: "已停用",
  retired: "已退役",
};

export function AgentsViewer() {
  const [agents, setAgents] = useState<AgentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    client.agents.list().then(
      (result) => {
        if (active) setAgents(result.items);
      },
      (reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof ControlPlaneRequestError
            ? `${reason.message}（请求 ${reason.requestId || "未知"}）`
            : "智能体列表加载失败",
        );
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mt-4 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-[13px]">
        <thead className="bg-[var(--surface-2)] text-[var(--fg-subtle)]">
          <tr>
            <th className="px-3 py-2 text-left font-medium">名称</th>
            <th className="px-3 py-2 text-left font-medium">标识</th>
            <th className="px-3 py-2 text-left font-medium">状态</th>
            <th className="px-3 py-2 text-left font-medium">当前修订</th>
            <th className="px-3 py-2 text-left font-medium">更新时间</th>
          </tr>
        </thead>
        <tbody>
          {agents === null && !error && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-[var(--fg-muted)]">
                正在加载…
              </td>
            </tr>
          )}
          {error && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-[var(--danger)]">
                {error}
              </td>
            </tr>
          )}
          {agents?.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-[var(--fg-muted)]">
                暂无智能体
              </td>
            </tr>
          )}
          {agents?.map((agent) => (
            <tr key={agent.id} className="border-t border-[var(--border)]">
              <td className="px-3 py-2 text-[var(--fg)]">
                <div>{agent.display_name}</div>
                {agent.description && (
                  <div className="text-[12px] text-[var(--fg-muted)]">{agent.description}</div>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-[var(--fg-muted)]">{agent.agent_key}</td>
              <td className="px-3 py-2 text-[var(--fg-muted)]">
                {LIFECYCLE_LABEL[agent.lifecycle_state]}
              </td>
              <td className="px-3 py-2 font-mono text-[var(--fg-muted)]">
                {agent.current_revision_id ?? "—"}
              </td>
              <td className="px-3 py-2 text-[var(--fg-muted)]">
                {agent.updated_at ? new Date(agent.updated_at).toLocaleString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
