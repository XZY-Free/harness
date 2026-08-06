/**
 * 稳定 Routes Schema — 正式控制面职责命名。
 */

export {
 deploymentRouteTable,
 deploymentRouteSetTable,
} from "@/lib/persistence/schema/deployment-route";

export type {
 RouteState,
 DeploymentRoute as DeploymentRouteRow,
 DeploymentRouteInsert as NewDeploymentRouteRow,
 DeploymentRouteSet as DeploymentRouteSetRow,
 DeploymentRouteSetInsert as NewDeploymentRouteSetRow,
} from "@/lib/persistence/schema/deployment-route";
