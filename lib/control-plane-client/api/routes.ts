/**
 * Route API Client — 消费 RouteSet / Route 端点。
 *
 * 写操作只保留 RouteSet 原子激活和正式 DisableRoute。
 * 单 Route 写入口已删除（§T11）。
 */

import type {
  ActivateRouteSetRequest,
  ActivateRouteSetResponse,
  DeploymentRouteDTO,
  DeploymentRouteSetDTO,
  DisableRouteRequest,
  DisableRouteResponse,
} from "../contracts/route";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** Route API Client。 */
export interface RouteApiClient {
  /** 获取 RouteSet 详情。 */
  getRouteSet(routeSetId: string): Promise<DeploymentRouteSetDTO>;
  /** 列出 RouteSet 下的 Route。 */
  listRoutes(routeSetId: string): Promise<{ items: DeploymentRouteDTO[]; total: number }>;
  /** 获取 Route 详情。 */
  getRoute(routeId: string): Promise<DeploymentRouteDTO>;
  /** RouteSet 原子激活 — 必填 Idempotency-Key + If-Match。 */
  activateRouteSet(
    routeSetId: string,
    body: ActivateRouteSetRequest,
    opts: { idempotencyKey: string; ifMatch: string },
  ): Promise<ActivateRouteSetResponse>;
  /** 禁用 Route — 调用正式 DisableRoute。 */
  disableRoute(
    routeId: string,
    body: DisableRouteRequest,
    opts: { idempotencyKey: string; ifMatch: string },
  ): Promise<DisableRouteResponse>;
}

/** 创建 Route API Client。 */
export function createRouteApiClient(config: ApiClientConfig): RouteApiClient {
  const request = createControlPlaneRequest(config);

  return {
    getRouteSet: (routeSetId) =>
      request<DeploymentRouteSetDTO>(`/admin/api/v1/deployment-route-sets/${routeSetId}`),
    listRoutes: (routeSetId) =>
      request<{ items: DeploymentRouteDTO[]; total: number }>(
        `/admin/api/v1/deployment-route-sets/${routeSetId}/routes`,
      ),
    getRoute: (routeId) =>
      request<DeploymentRouteDTO>(`/admin/api/v1/deployment-routes/${routeId}`),
    activateRouteSet: (routeSetId, body, opts) =>
      request<ActivateRouteSetResponse>(
        `/admin/api/v1/deployment-route-sets/${routeSetId}/activation`,
        {
          method: "PUT",
          body: JSON.stringify(body),
          headers: {
            "Idempotency-Key": opts.idempotencyKey,
            "If-Match": opts.ifMatch,
          },
        },
      ),
    disableRoute: (routeId, body, opts) =>
      request<DisableRouteResponse>(`/admin/api/v1/deployment-routes/${routeId}/disable`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Idempotency-Key": opts.idempotencyKey,
          "If-Match": opts.ifMatch,
        },
      }),
  };
}
