/**
 * Runtime API Client — 消费 Runtime 控制面端点。
 */

import type {
  PublishRuntimeRevisionRequest,
  RecordConformanceRunRequest,
  RuntimeConformanceRunDTO,
  RuntimeDTO,
  RuntimeListResponse,
  RuntimeRevisionDTO,
} from "../contracts/runtime";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** Runtime API Client。 */
export interface RuntimeApiClient {
  /** 列出 Runtime。 */
  list(): Promise<RuntimeListResponse>;
  /** 获取 Runtime 详情。 */
  get(runtimeId: string): Promise<RuntimeDTO>;
  /** 列出 RuntimeRevision。 */
  listRevisions(runtimeId: string): Promise<{ items: RuntimeRevisionDTO[]; total: number }>;
  /** 获取 RuntimeRevision 详情。 */
  getRevision(revisionId: string): Promise<RuntimeRevisionDTO>;
  /** 发布 RuntimeRevision — 必须显式传入 attestation_ids 和 conformance_run_id。 */
  publishRevision(
    revisionId: string,
    body: PublishRuntimeRevisionRequest,
  ): Promise<RuntimeRevisionDTO>;
  /** 撤回 RuntimeRevision。 */
  withdrawRevision(revisionId: string, reason: string): Promise<RuntimeRevisionDTO>;
  /** 记录 Conformance Run。 */
  recordConformanceRun(
    revisionId: string,
    body: RecordConformanceRunRequest,
  ): Promise<RuntimeConformanceRunDTO>;
  /** 获取 Conformance Run 详情。 */
  getConformanceRun(runId: string): Promise<RuntimeConformanceRunDTO>;
}

/** 创建 Runtime API Client。 */
export function createRuntimeApiClient(config: ApiClientConfig): RuntimeApiClient {
  const request = createControlPlaneRequest(config);

  return {
    list: () => request<RuntimeListResponse>("/admin/api/v1/runtimes"),
    get: (runtimeId) => request<RuntimeDTO>(`/admin/api/v1/runtimes/${runtimeId}`),
    listRevisions: (runtimeId) =>
      request<{ items: RuntimeRevisionDTO[]; total: number }>(
        `/admin/api/v1/runtimes/${runtimeId}/revisions`,
      ),
    getRevision: (revisionId) =>
      request<RuntimeRevisionDTO>(`/admin/api/v1/runtime-revisions/${revisionId}`),
    publishRevision: (revisionId, body) =>
      request<RuntimeRevisionDTO>(`/admin/api/v1/runtime-revisions/${revisionId}:publish`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    withdrawRevision: (revisionId, reason) =>
      request<RuntimeRevisionDTO>(`/admin/api/v1/runtime-revisions/${revisionId}:withdraw`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    recordConformanceRun: (revisionId, body) =>
      request<RuntimeConformanceRunDTO>(
        `/admin/api/v1/runtime-revisions/${revisionId}/conformance`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    getConformanceRun: (runId) =>
      request<RuntimeConformanceRunDTO>(`/admin/api/v1/conformance-runs/${runId}`),
  };
}
