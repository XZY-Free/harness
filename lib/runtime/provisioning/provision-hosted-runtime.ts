/**
 * Hosted Provisioning 类型定义。
 *
 * Hosted Runtime 供应使用分步 Gateway，由 Saga 负责编排。
 * 异步 Saga（hosted-provisioning-saga.ts）+ Gateway 接口是唯一的供应路径。
 * 本文件仅保留 Gateway 接口共享的类型定义。
 */

export interface HostedRuntimeRoute {
  routeId: string;
  routeRevisionId: string;
  routeActivationId: string;
  /** null = 基础 Harness Route（无 Agent 资产约束）。 */
  agentRevisionId: string | null;
  runtimeRevisionId: string;
  /** Projection 版本号，用于精确 ID 验证。 */
  projectionVersionNo?: number | null;
}

export interface PublishedHostedAgentRevision {
  revisionId: string;
  publicationRecordId: string;
}

export interface PublishedHostedRuntimeRevision {
  revisionId: string;
  publicationRecordId: string;
  attestationId: string;
  conformanceRunId: string;
}
