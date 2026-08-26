import { AgentRegistrationWorkspace } from "@/components/studio/agent-registration-workspace";
import { StudioGatePage } from "@/components/studio/gate-page";
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
  const canRegisterRuntime = await hasStudioAction(gate.principal, "agent.runtime.register");

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">资源</h1>
      <AgentRegistrationWorkspace
        canReadAgents={canReadAgents}
        canRegisterContract={canRegisterContract}
        canManageRevisions={canManageRevisions}
        canRegisterRuntime={canRegisterRuntime}
      />
    </div>
  );
}
