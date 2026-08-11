/**
 * Execution API Client — 消费 ExecutionBinding 端点。
 *
 * 桌面端通过此客户端获取不可变 Binding，禁止自行创建。
 */

import type { ExecutionBindingDTO } from "../contracts/execution";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** Execution API Client。 */
export interface ExecutionApiClient {
  /** 获取 Invocation 的 ExecutionBinding。 */
  getBinding(invocationId: string): Promise<ExecutionBindingDTO>;
}

/** 创建 Execution API Client。 */
export function createExecutionApiClient(config: ApiClientConfig): ExecutionApiClient {
  const request = createControlPlaneRequest(config);

  return {
    getBinding: (invocationId) =>
      request<ExecutionBindingDTO>(`/admin/api/v1/invocations/${invocationId}/execution-binding`),
  };
}
