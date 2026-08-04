/** Hosted Runtime 接入的稳定组装入口。 */
import "@/lib/runtimes/infrastructure/configured-hosted-control-plane-evidence";
import { createProvisionHostedRuntime } from "@/lib/runtimes/application/provision-hosted-runtime";
import { mysqlHostedRuntimeControlPlane } from "@/lib/runtimes/persistence/mysql-hosted-runtime-control-plane";

const provisionHostedRuntime = createProvisionHostedRuntime({
  controlPlane: mysqlHostedRuntimeControlPlane,
});

export interface HostedRouteBootstrapResult {
  routeId: string;
  agentRevisionId: string;
  runtimeRevisionId: string;
}

export async function ensureHostedRouteForAgent(params: {
  tenantId: string;
  agentId: string;
}): Promise<HostedRouteBootstrapResult> {
  const result = await provisionHostedRuntime({
    ...params,
    routeScopeKey: "default",
  });
  return {
    routeId: result.routeId,
    agentRevisionId: result.agentRevisionId,
    runtimeRevisionId: result.runtimeRevisionId,
  };
}
