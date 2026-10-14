"use client";

import { AgentRegistrationWorkspace } from "@/components/studio/agent-registration-workspace";
import { useStudioContext } from "@/components/studio/studio-shell";
import {
  snapshotAllowsAnyScope,
  snapshotAllowsTenantAction,
} from "@/lib/client/studio-permissions";
import { ENTERPRISE_ATTRIBUTE_CATALOG } from "@/lib/identity/enterprise-attribute-catalog";

/**
 * 智能体管理入口（页面数据 API 化）。
 *
 * 列表与连续登记共用工作区，运行服务治理保留在独立 Runtime 入口。
 * 能力判定走权限快照轻量断言（服务端 API 兜底）；工作区数据由组件自取。
 */
export default function ResourcesPage() {
  const { snapshot } = useStudioContext();
  const canReadAgents = snapshotAllowsTenantAction(snapshot, "agent.read");
  const canRegisterContract = snapshotAllowsAnyScope(snapshot, "agent.contract.register");
  const canManageRevisions = snapshotAllowsAnyScope(snapshot, "agent.revision.create");
  const canManageRoutes = snapshotAllowsAnyScope(snapshot, "route.update");
  const canDelete = canRegisterContract && snapshotAllowsAnyScope(snapshot, "agent.retract");
  const projectableFields = Object.values(ENTERPRISE_ATTRIBUTE_CATALOG)
    .filter((field) => field.agentProjectionAllowed)
    .map((field) => field.key);

  return (
    <AgentRegistrationWorkspace
      canDelete={canDelete}
      projectableFields={projectableFields}
      canReadAgents={canReadAgents}
      canRegisterContract={canRegisterContract}
      canManageRevisions={canManageRevisions}
      canManageRoutes={canManageRoutes}
    />
  );
}
