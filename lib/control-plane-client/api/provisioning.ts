/**
 * Provisioning API Client — 消费 Hosted 供应端点。
 */

import type {
  HostedProvisioningRequestDTO,
  RequestHostedProvisioningRequest,
} from "../contracts/provisioning";
import type { ApiClientConfig } from "./agents";

/** Provisioning API Client。 */
export interface ProvisioningApiClient {
  /** 请求 Hosted 供应。 */
  requestProvisioning(body: RequestHostedProvisioningRequest): Promise<HostedProvisioningRequestDTO>;
  /** 获取供应请求详情。 */
  getProvisioningRequest(requestId: string): Promise<HostedProvisioningRequestDTO>;
}

/** 创建 Provisioning API Client。 */
export function createProvisioningApiClient(config: ApiClientConfig): ProvisioningApiClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${config.baseUrl}${path}`;
    const headers = { ...config.headers(), "Content-Type": "application/json" };
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.message ?? `HTTP ${res.status}`), {
        code: body.code,
        request_id: body.request_id,
        details: body.details,
      });
    }
    return res.json();
  }

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
