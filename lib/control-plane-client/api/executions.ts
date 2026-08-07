/**
 * Execution API Client — 消费 ExecutionBinding 端点。
 *
 * 桌面端通过此客户端获取不可变 Binding，禁止自行创建。
 */

import type { ExecutionBindingDTO } from "../contracts/execution";
import type { ApiClientConfig } from "./agents";

/** Execution API Client。 */
export interface ExecutionApiClient {
  /** 获取 Invocation 的 ExecutionBinding。 */
  getBinding(invocationId: string): Promise<ExecutionBindingDTO>;
}

/** 创建 Execution API Client。 */
export function createExecutionApiClient(config: ApiClientConfig): ExecutionApiClient {
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
    getBinding: (invocationId) =>
      request<ExecutionBindingDTO>(`/admin/api/v1/invocations/${invocationId}/execution-binding`),
  };
}
