/**
 * Provisioning API Client — 消费 Hosted 供应端点。
 */

import type {
  HostedProvisioningRequestDTO,
  RequestHostedProvisioningRequest,
} from "../contracts/provisioning";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** Provisioning API Client。 */
export interface ProvisioningApiClient {
  /** 请求 Hosted 供应。 */
  requestProvisioning(
    body: RequestHostedProvisioningRequest,
  ): Promise<HostedProvisioningRequestDTO>;
  /** 获取供应请求详情。 */
  getProvisioningRequest(requestId: string): Promise<HostedProvisioningRequestDTO>;
}

/** 创建 Provisioning API Client。 */
export function createProvisioningApiClient(config: ApiClientConfig): ProvisioningApiClient {
  const request = createControlPlaneRequest(config);

  return {
    requestProvisioning: (body) =>
      request<HostedProvisioningRequestDTO>("/admin/api/v1/hosted-provisioning", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    getProvisioningRequest: (requestId) =>
      request<HostedProvisioningRequestDTO>(`/admin/api/v1/hosted-provisioning/${requestId}`),
  };
}
