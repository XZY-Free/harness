import { AgentRegistrationWorkspace } from "@/components/studio/agent-registration-workspace";
import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioPage } from "@/components/studio/studio-page";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Studio 智能体控制面资源页（07 §4–§8）。
 *
 * 信息架构不变：档案 / 合同登记 / Revision 操作 / Runtime 登记统一由
 * AgentRegistrationWorkspace 渲染并共享“导入合同后连续交接”状态；
 * 全部经 control-plane-client 走正式 Admin API，UI 不是最终授权。
 */
export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canReadAgents = await hasStudioAction(gate.principal, "agent.read");
  const canRegisterContract = await hasStudioAction(gate.principal, "agent.contract.register");
  const canManageRevisions = await hasStudioAction(gate.principal, "agent.revision.create");
  const canPublishRuntime = await hasStudioAction(gate.principal, "runtime.publish");
  const canManageRoutes = await hasStudioAction(gate.principal, "route.update");

  return (
    <StudioPage
      title="智能体"
      description="登记外部智能体，管理版本、运行服务和员工侧发布。"
      width="wide"
    >
      <AgentRegistrationWorkspace
        canReadAgents={canReadAgents}
        canRegisterContract={canRegisterContract}
        canManageRevisions={canManageRevisions}
        canPublishRuntime={canPublishRuntime}
        canManageRoutes={canManageRoutes}
      />
    </StudioPage>
  );
}
