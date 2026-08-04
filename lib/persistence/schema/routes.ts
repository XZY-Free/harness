/**
 * 稳定 Routes Schema — 正式控制面职责命名。
 */

export {
  v11DeploymentRoute as deploymentRouteTable,
  v11DeploymentRouteSet as deploymentRouteSetTable,
} from "@/lib/v11/schema/deployment-route";

export type {
  RouteState,
  V11DeploymentRoute as DeploymentRouteRow,
  V11DeploymentRouteInsert as NewDeploymentRouteRow,
  V11DeploymentRouteSet as DeploymentRouteSetRow,
  V11DeploymentRouteSetInsert as NewDeploymentRouteSetRow,
} from "@/lib/v11/schema/deployment-route";
