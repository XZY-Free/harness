/**
 * Hosted Provisioning 类型定义。
 *
 * §7.1: 移除旧同步 HostedRuntimeControlPlane + createProvisionHostedRuntime。
 * 异步 Saga（hosted-provisioning-saga.ts）+ Gateway 接口是唯一的供应路径。
 * 本文件仅保留 Gateway 接口共享的类型定义。
 */

export interface HostedRuntimeRoute {
  routeId: string;
  routeRevisionId: string;
  routeActivationId: string;
  agentRevisionId: string;
  runtimeRevisionId: string;
  /** §08.11: Projection 版本号，用于精确 ID 验证。 */
  projectionVersionNo?: number | null;
}

export interface PublishedHostedAgentRevision {
  revisionId: string;
  publicationRecordId: string;
  attestationId: string;
}

export interface PublishedHostedRuntimeRevision {
  revisionId: string;
  publicationRecordId: string;
  attestationId: string;
  conformanceRunId: string;
}
