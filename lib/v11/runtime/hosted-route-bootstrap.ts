/**
 * Hosted Runtime 旧入口兼容 Facade。
 *
 * 正式编排位于 runtimes/application，MySQL 与旧表装配位于 compatibility/hosted。
 * 本文件只保留历史 import 和响应形状，不再创建或发布任何控制面事实。
 */
import { mysqlHostedRuntimeControlPlane } from "@/lib/compatibility/hosted/mysql-hosted-runtime-control-plane";
import { createProvisionHostedRuntime } from "@/lib/runtimes/application/provision-hosted-runtime";

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
