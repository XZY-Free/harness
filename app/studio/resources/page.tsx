import { AgentRegistrationWorkspace } from "@/components/studio/agent-registration-workspace";
import { StudioGatePage } from "@/components/studio/gate-page";
import { ENTERPRISE_ATTRIBUTE_CATALOG } from "@/lib/identity/enterprise-user";
import { hasStudioAction, hasStudioActionInAnyScope } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/** 智能体管理入口：列表与连续登记共用工作区，运行服务治理保留在独立 Runtime 入口。 */
export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canReadAgents = await hasStudioAction(gate.principal, "agent.read");
  const canRegisterContract = await hasStudioActionInAnyScope(
    gate.principal,
    "agent.contract.register",
  );
  const canManageRevisions = await hasStudioActionInAnyScope(
    gate.principal,
    "agent.revision.create",
  );
  const canManageRoutes = await hasStudioActionInAnyScope(gate.principal, "route.update");

  return (
    <AgentRegistrationWorkspace
      canDelete={
        canRegisterContract && (await hasStudioActionInAnyScope(gate.principal, "agent.retract"))
      }
      projectableFields={Object.values(ENTERPRISE_ATTRIBUTE_CATALOG)
        .filter((field) => field.agentProjectionAllowed)
        .map((field) => field.key)}
      canReadAgents={canReadAgents}
      canRegisterContract={canRegisterContract}
      canManageRevisions={canManageRevisions}
      canManageRoutes={canManageRoutes}
    />
  );
}
