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
import { RuntimeControlPanel } from "@/components/studio/runtime-control-panel";
import type {
  RegisterAgentContractResponse,
  RegisterAgentRuntimeResponse,
} from "@/lib/control-plane-client";
import { useCallback, useState } from "react";

/** 登记成功后的交接：空值表示尚无已登记合同。 */
interface RegistrationHandoff {
  readonly agentId: string | null;
  readonly snapshotId: string | null;
  readonly refreshToken: number;
}

/** Runtime 登记成功后的交接：只刷新 RuntimeControlPanel 并聚焦刚登记版本。 */
interface RuntimeHandoff {
  readonly revisionId: string | null;
  readonly refreshToken: number;
}

interface AgentRegistrationWorkspaceProps {
  readonly canReadAgents: boolean;
  readonly canRegisterContract: boolean;
  readonly canManageRevisions: boolean;
  readonly canRegisterRuntime: boolean;
  /** 发布运行服务版本权限（runtime.publish）；默认 false，无权限不渲染发布区域。 */
  readonly canPublishRuntime?: boolean;
}

export function AgentRegistrationWorkspace({
  canReadAgents,
  canRegisterContract,
  canManageRevisions,
  canRegisterRuntime,
  canPublishRuntime = false,
}: AgentRegistrationWorkspaceProps) {
  const [handoff, setHandoff] = useState<RegistrationHandoff>({
    agentId: null,
    snapshotId: null,
    refreshToken: 0,
  });
  const [runtimeHandoff, setRuntimeHandoff] = useState<RuntimeHandoff>({
    revisionId: null,
    refreshToken: 0,
  });

  const handleRegistered = useCallback((result: RegisterAgentContractResponse) => {
    setHandoff((current) => ({
      agentId: result.agent.id,
      snapshotId: result.contract.snapshot_id,
      refreshToken: current.refreshToken + 1,
    }));
  }, []);

  // Runtime 登记成功：只交接 runtime_revision_id 并递增 Runtime 刷新代次；
  // 发布运行服务版本必须由用户在同页 RuntimeControlPanel 中点击触发，不自动发布。
  const handleRuntimeRegistered = useCallback((result: RegisterAgentRuntimeResponse) => {
    setRuntimeHandoff((current) => ({
      revisionId: result.runtime_revision_id,
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
            onRegistered={handleRuntimeRegistered}
          />
        </div>
      )}

      {/* runtime.publish 的 action scope 是 runtime/environment，后端独立授权；
          发布入口只由 canPublishRuntime 控制，不附加智能体读取权限。 */}
      {canPublishRuntime && (
        <div className="mt-6">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">
            发布运行服务版本（外部服务须先通过实际能力验收）。
          </p>
          <RuntimeControlPanel
            canPublish
            refreshToken={runtimeHandoff.refreshToken}
            preferredRuntimeRevisionId={runtimeHandoff.revisionId}
          />
        </div>
      )}
    </div>
  );
}
