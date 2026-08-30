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
import { AgentsViewer } from "@/components/studio/agents-viewer";
import { RouteActivationPanel } from "@/components/studio/route-activation-panel";
import { RuntimeControlPanel } from "@/components/studio/runtime-control-panel";
import type {
  PublishAgentRevisionResponse,
  RegisterAgentContractResponse,
} from "@/lib/control-plane-client";
import { useCallback, useState } from "react";

/** 登记成功后的交接：空值表示尚无已登记合同。 */
interface RegistrationHandoff {
  readonly agentId: string | null;
  readonly snapshotId: string | null;
  readonly refreshToken: number;
}

/** 「发布给员工」交接：只携带真实 Agent publish API 返回的 revision id。 */
interface RouteHandoff {
  readonly agentRevisionId: string | null;
  readonly refreshToken: number;
}

interface AgentRegistrationWorkspaceProps {
  readonly canReadAgents: boolean;
  readonly canRegisterContract: boolean;
  readonly canManageRevisions: boolean;
  /** 发布运行服务版本权限（runtime.publish）；默认 false，无权限不渲染发布区域。 */
  readonly canPublishRuntime?: boolean;
  /** 路由管理权限（route.update）；默认 false，无权限不渲染「发布给员工」区域。 */
  readonly canManageRoutes?: boolean;
}

export function AgentRegistrationWorkspace({
  canReadAgents,
  canRegisterContract,
  canManageRevisions,
  canPublishRuntime = false,
  canManageRoutes = false,
}: AgentRegistrationWorkspaceProps) {
  const [handoff, setHandoff] = useState<RegistrationHandoff>({
    agentId: null,
    snapshotId: null,
    refreshToken: 0,
  });
  const [routeHandoff, setRouteHandoff] = useState<RouteHandoff>({
    agentRevisionId: null,
    refreshToken: 0,
  });

  const handleRegistered = useCallback((result: RegisterAgentContractResponse) => {
    setHandoff((current) => ({
      agentId: result.agent.id,
      snapshotId: result.contract.snapshot_id,
      refreshToken: current.refreshToken + 1,
    }));
  }, []);

  // 只由真实 Agent publish API 成功返回触发：交接返回 id 并刷新 Agent 路由面板。
  const handleAgentRevisionPublished = useCallback((result: PublishAgentRevisionResponse) => {
    setRouteHandoff((current) => ({
      agentRevisionId: result.id,
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
          <AgentsViewer refreshToken={handoff.refreshToken + routeHandoff.refreshToken} />
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
            onPublished={handleAgentRevisionPublished}
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
          <RuntimeControlPanel canPublish refreshToken={0} preferredRuntimeRevisionId={null} />
        </div>
      )}

      {/* route.update 的 action scope 由服务端独立授权；发布给员工入口只由
          canManageRoutes 控制显示。面板只接收真实 Agent publish API 返回的
          revision id，并在重新 GET 的真实 published 列表中验证后才选择，
          路由写仍由用户显式点击触发。 */}
      {canManageRoutes && (
        <div className="mt-6">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">
            发布给员工：选择已发布的智能体版本并填写调用地址，激活默认路由。
          </p>
          <RouteActivationPanel
            canManage
            refreshToken={routeHandoff.refreshToken}
            preferredAgentRevisionId={routeHandoff.agentRevisionId}
          />
        </div>
      )}
    </div>
  );
}
