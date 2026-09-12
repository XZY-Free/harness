"use client";

import { AgentDeleteButton } from "@/components/studio/agent-delete-button";
import { Button } from "@/components/ui/button";
import { type AgentDTO, createControlPlaneClient } from "@/lib/control-plane-client";
import { ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

const LIFECYCLE_LABEL: Record<AgentDTO["lifecycle_state"], string> = {
  draft: "待配置",
  enabled: "已登记",
  disabled: "已停用",
  retired: "已退役",
};

interface AgentsViewerProps {
  /** 递增代次：合同登记等上游变更后重新加载 Agent 列表。 */
  readonly canDelete?: boolean;
  readonly refreshToken?: number;
  readonly onManage?: (agent: AgentDTO) => void;
}

export function AgentsViewer({ refreshToken = 0, onManage, canDelete = false }: AgentsViewerProps) {
  const [agents, setAgents] = useState<AgentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (agents?.length === 0 && !error)
    return (
      <div className="rounded-xl border border-dashed px-6 py-16 text-center">
        <h2 className="text-base font-medium">暂无智能体</h2>
        <p className="mt-2 text-sm text-muted-foreground">点击右上角“登记智能体”，开始接入。</p>
      </div>
    );

  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <thead className="hidden bg-muted/60 text-muted-foreground md:table-header-group">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium">智能体</th>
            <th className="px-4 py-3 text-left text-xs font-medium">状态</th>
            <th className="px-4 py-3 text-left text-xs font-medium">使用设置</th>
            <th className="px-4 py-3 text-left text-xs font-medium">更新时间</th>
            <th className="px-4 py-3 text-right text-xs font-medium">操作</th>
          </tr>
        </thead>
        <tbody className="block md:table-row-group">
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
            <tr
              key={agent.id}
              className="grid grid-cols-2 items-center border-t first:border-t-0 md:table-row"
            >
              <td className="col-span-2 px-4 py-3">
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
                <span className="mr-2 text-xs md:hidden">使用设置</span>
                {agent.current_revision_id ? "已保存" : "待设置"}
              </td>
              <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                {agent.updated_at ? new Date(agent.updated_at).toLocaleString("zh-CN") : "—"}
              </td>
              <td className="col-span-2 border-t px-4 py-2 text-right md:border-t-0 md:py-3">
                {onManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onManage(agent)}
                    aria-label={`配置${agent.display_name}`}
                  >
                    配置
                  </Button>
                )}
                <Link
                  href={`/studio/agents/${agent.id}`}
                  aria-label={`查看${agent.display_name}详情`}
                  className="inline-flex items-center gap-1 rounded-md px-3 py-2 font-medium hover:bg-muted focus-visible:outline-2"
                >
                  查看
                  <ChevronRight className="size-4" aria-hidden />
                </Link>
                {
                  <AgentDeleteButton
                    agent={agent}
                    canDelete={canDelete}
                    onDeleted={() =>
                      setAgents((items) => items?.filter((item) => item.id !== agent.id) ?? null)
                    }
                  />
                }
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
