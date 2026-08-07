/**
 * HostedProvisioningRequest Store 接口。
 */

import type { ProvisioningState } from "../domain/hosted-provisioning-request";
import type { HostedProvisioningRequestRow } from "./hosted-provisioning-request-record";

export interface HostedProvisioningRequestStore {
 /** 插入请求。 */
 insert(input: NewProvisioningRequestInput): Promise<HostedProvisioningRequestRow>;

 /** 按 ID 读取。 */
 getById(params: {
 tenantId: string;
 requestId: string;
 }): Promise<HostedProvisioningRequestRow | null>;

 /** 按 AgentRevision + RouteScope + RuntimeKey 查找活跃请求。 */
 findActiveRequest(params: {
 tenantId: string;
 agentRevisionId: string;
 routeScopeKey: string;
 desiredRuntimeKey: string;
 }): Promise<HostedProvisioningRequestRow | null>;

 /** 按 Agent 查找 ready 请求。 */
 findReadyByAgent(params: {
 tenantId: string;
 agentId: string;
 routeScopeKey: string;
 }): Promise<HostedProvisioningRequestRow | null>;

 /** 更新状态。: 必须提供 workerId 进行 lease owner 校验。 */
 updateState(params: {
 requestId: string;
 /** : Lease Owner 校验 — WHERE leaseOwner = workerId。 */
 workerId?: string;
 state: ProvisioningState;
 currentStep?: string | null;
 attemptCount?: number;
 nextAttemptAt?: Date | null;
 leaseOwner?: string | null;
 leaseExpiresAt?: Date | null;
 lastError?: string | null;
 lastAttemptAt?: Date | null;
 /** : Step Checkpoint 更新。 */
 checkpoint?: StepCheckpoint;
 /** : 最近完成的步骤。 */
 lastCompletedStep?: string | null;
 }): Promise<HostedProvisioningRequestRow>;

 /** 领取可处理的请求（FOR UPDATE SKIP LOCKED）。 */
 claimRequests(params: {
 workerId: string;
 leaseMs: number;
 batchSize: number;
 now: Date;
 }): Promise<HostedProvisioningRequestRow[]>;

 /** 释放租约。: 必须提供 workerId。 */
 releaseLease(params: { requestId: string; workerId: string }): Promise<void>;
}

export interface NewProvisioningRequestInput {
 id: string;
 tenantId: string;
 agentId: string;
 agentRevisionId: string;
 routeScopeKey: string;
 desiredRuntimeKey: string;
 state?: ProvisioningState;
 createdAt: Date;
 updatedAt: Date;
}

/** : Step Checkpoint — Saga 每步完成后的产出数据。 */
export interface StepCheckpoint {
 agentRevisionId?: string | null;
 agentPublicationRecordId?: string | null;
 agentAttestationId?: string | null;
 runtimeId?: string | null;
 runtimeRevisionId?: string | null;
 runtimeArtifactId?: string | null;
 runtimeAttestationIds?: string[] | null;
 runtimePublicationRecordId?: string | null;
 conformanceRunId?: string | null;
 routeSetId?: string | null;
 routeSetVersionNo?: number | null;
 routeId?: string | null;
 routeRevisionId?: string | null;
 routeActivationId?: string | null;
 projectionVersionNo?: number | null;
}
