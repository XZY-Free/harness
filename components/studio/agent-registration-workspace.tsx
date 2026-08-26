"use client";

/**
 * 资源页智能体登记工作台：把档案 / 合同登记 / 版本操作 / Runtime 登记
 * 四块放进同一棵子树，共享“登记合同 → 创建版本 → 登记 Runtime”的交接状态。
 *
 * 交接只携带后端返回的 agent.id + contract.snapshot_id 与递增 refreshToken；
 * 不持久化合同文件本体、文件名、路径或原始文本。
 */
import { AgentContractRegistrationPanel } from "@/components/studio/agent-contract-registration-panel";
import { AgentsRevisionSection } from "@/components/studio/agent-revision-section";
import { AgentRuntimeRegistrationPanel } from "@/components/studio/agent-runtime-registration-panel";
import { AgentsViewer } from "@/components/studio/agents-viewer";
import type { RegisterAgentContractResponse } from "@/lib/control-plane-client";
import { useCallback, useState } from "react";

/** 登记成功后的交接：空值表示尚无已登记合同。 */
interface RegistrationHandoff {
  readonly agentId: string | null;
  readonly snapshotId: string | null;
  readonly refreshToken: number;
}

interface AgentRegistrationWorkspaceProps {
  readonly canReadAgents: boolean;
  readonly canRegisterContract: boolean;
  readonly canManageRevisions: boolean;
  readonly canRegisterRuntime: boolean;
}

export function AgentRegistrationWorkspace({
  canReadAgents,
  canRegisterContract,
  canManageRevisions,
  canRegisterRuntime,
}: AgentRegistrationWorkspaceProps) {
  const [handoff, setHandoff] = useState<RegistrationHandoff>({
    agentId: null,
    snapshotId: null,
    refreshToken: 0,
  });

  const handleRegistered = useCallback((result: RegisterAgentContractResponse) => {
    setHandoff((current) => ({
      agentId: result.agent.id,
      snapshotId: result.contract.snapshot_id,
      refreshToken: current.refreshToken + 1,
    }));
  }, []);

  return (
    <div>
      {!canReadAgents ? (
        <p className="mt-4 text-[13px] text-[var(--fg-muted)]">无可见资源档案。</p>
      ) : (
        <div className="mt-4">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">智能体档案与当前版本。</p>
          <AgentsViewer refreshToken={handoff.refreshToken} />
        </div>
      )}

      {canRegisterContract && (
        <div className="mt-6">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">
            导入外部智能体合同。运行地址和访问凭证在后续步骤填写。
          </p>
          <AgentContractRegistrationPanel onRegistered={handleRegistered} />
        </div>
      )}

      {canManageRevisions && canReadAgents && (
        <div className="mt-6">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">创建、发布或撤回智能体版本。</p>
          <AgentsRevisionSection
            preferredAgentId={handoff.agentId}
            preferredSnapshotId={handoff.snapshotId}
            refreshToken={handoff.refreshToken}
          />
        </div>
      )}

      {canRegisterRuntime && canReadAgents && (
        <div className="mt-6">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">
            登记外部运行服务并执行实际能力验收。访问令牌只能选择已有凭证引用。
          </p>
          <AgentRuntimeRegistrationPanel
            preferredAgentId={handoff.agentId}
            preferredSnapshotId={handoff.snapshotId}
            refreshToken={handoff.refreshToken}
          />
        </div>
      )}
    </div>
  );
}
