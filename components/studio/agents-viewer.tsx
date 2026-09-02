"use client";

import { AgentContractPanel } from "@/components/studio/agent-contract-panel";
import { Button } from "@/components/ui/button";
import { type AgentDTO, createControlPlaneClient } from "@/lib/control-plane-client";
import { ChevronDown, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

const LIFECYCLE_LABEL: Record<AgentDTO["lifecycle_state"], string> = {
  draft: "草稿",
  enabled: "已启用",
  disabled: "已停用",
  retired: "已退役",
};

interface AgentsViewerProps {
  /** 递增代次：合同登记等上游变更后重新加载 Agent 列表。 */
  readonly refreshToken?: number;
}

export function AgentsViewer({ refreshToken = 0 }: AgentsViewerProps) {
  const [agents, setAgents] = useState<AgentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const loadContracts = useCallback((agentId: string) => client.agents.listContracts(agentId), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是刷新代次信号（合同登记后重载列表），非直接引用
  useEffect(() => {
    let active = true;
    // 新一轮加载开始即清除上一轮的错误；失败时再设置本次真实错误。
    setError(null);
    client.agents.list().then(
      (result) => {
        if (!active) return;
        setAgents(result.items);
        setError(null);
      },
      () => {
        if (!active) return;
        setError("智能体列表加载失败，请稍后重试");
      },
    );
    return () => {
      active = false;
    };
  }, [refreshToken]);

  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="min-w-[680px] w-full text-sm">
        <thead className="bg-muted/60 text-muted-foreground">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium">智能体</th>
            <th className="px-4 py-3 text-left text-xs font-medium">状态</th>
            <th className="px-4 py-3 text-left text-xs font-medium">当前版本</th>
            <th className="px-4 py-3 text-left text-xs font-medium">更新时间</th>
            <th className="px-4 py-3 text-right text-xs font-medium">合同</th>
          </tr>
        </thead>
        <tbody>
          {agents === null && !error && (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                <output aria-live="polite" className="inline-flex items-center gap-2 text-sm">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  正在加载智能体…
                </output>
              </td>
            </tr>
          )}
          {error && (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center">
                <div
                  role="alert"
                  className="inline-flex items-center gap-2 text-sm text-destructive"
                >
                  <CircleAlert className="size-4" aria-hidden />
                  {error}
                </div>
              </td>
            </tr>
          )}
          {agents?.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                暂无智能体
              </td>
            </tr>
          )}
          {agents?.map((agent) => (
            <Fragment key={agent.id}>
              <tr className="border-t first:border-t-0">
                <td className="px-4 py-3">
                  <div className="font-medium text-foreground">{agent.display_name}</div>
                  {agent.description && (
                    <div className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
                      {agent.description}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground">
                    {LIFECYCLE_LABEL[agent.lifecycle_state]}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {agent.current_revision_id ? "已关联版本" : "尚未关联"}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {agent.updated_at ? new Date(agent.updated_at).toLocaleString("zh-CN") : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={expandedAgentId === agent.id}
                    aria-label={`${expandedAgentId === agent.id ? "收起" : "查看"}${agent.display_name}合同`}
                    onClick={() =>
                      setExpandedAgentId((current) => (current === agent.id ? null : agent.id))
                    }
                  >
                    {expandedAgentId === agent.id ? "收起" : "查看"}
                    {expandedAgentId === agent.id ? (
                      <ChevronDown className="size-4" aria-hidden />
                    ) : (
                      <ChevronRight className="size-4" aria-hidden />
                    )}
                  </Button>
                </td>
              </tr>
              {expandedAgentId === agent.id && (
                <tr className="border-t bg-muted/30">
                  <td colSpan={5} className="p-0">
                    <AgentContractPanel agentId={agent.id} loadContracts={loadContracts} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
