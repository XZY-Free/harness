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
import { BookOpenCheck, FileUp, GitBranch, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
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

function WorkspaceSection({
  title,
  description,
  icon: Icon,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="flex items-start gap-3 border-b bg-muted/40 px-5 py-4">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
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
    <div className="space-y-5">
      {!canReadAgents ? (
        <div className="rounded-2xl border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
          当前账号没有可查看的智能体。
        </div>
      ) : (
        <WorkspaceSection
          title="智能体档案"
          description="查看已登记的智能体、启用状态和当前版本。"
          icon={BookOpenCheck}
        >
          <AgentsViewer refreshToken={handoff.refreshToken + routeHandoff.refreshToken} />
        </WorkspaceSection>
      )}

      {canRegisterContract && (
        <WorkspaceSection
          title="导入合同"
          description="选择智能体合同文件，核对内容后完成登记。运行地址与访问凭证稍后配置。"
          icon={FileUp}
        >
          <AgentContractRegistrationPanel onRegistered={handleRegistered} />
        </WorkspaceSection>
      )}

      {canManageRevisions && canReadAgents && (
        <WorkspaceSection
          title="版本管理"
          description="基于已登记合同创建版本，并控制员工侧可用状态。"
          icon={GitBranch}
        >
          <AgentsRevisionSection
            preferredAgentId={handoff.agentId}
            preferredSnapshotId={handoff.snapshotId}
            refreshToken={handoff.refreshToken}
            onPublished={handleAgentRevisionPublished}
          />
        </WorkspaceSection>
      )}

      {/* runtime.publish 的 action scope 是 runtime/environment，后端独立授权；
          发布入口只由 canPublishRuntime 控制，不附加智能体读取权限。 */}
      {canPublishRuntime && (
        <RuntimeControlPanel canPublish refreshToken={0} preferredRuntimeRevisionId={null} />
      )}

      {/* route.update 的 action scope 由服务端独立授权；发布给员工入口只由
          canManageRoutes 控制显示。面板只接收真实 Agent publish API 返回的
          revision id，并在重新 GET 的真实 published 列表中验证后才选择，
          路由写仍由用户显式点击触发。 */}
      {canManageRoutes && (
        <RouteActivationPanel
          canManage
          refreshToken={routeHandoff.refreshToken}
          preferredAgentRevisionId={routeHandoff.agentRevisionId}
        />
      )}
    </div>
  );
}
