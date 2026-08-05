/**
 * HostedProvisioningRequest Store 接口。
 */

import type {
  HostedProvisioningRequestRow,
} from "./hosted-provisioning-request-record";
import type { ProvisioningState } from "../domain/hosted-provisioning-request";

export interface HostedProvisioningRequestStore {
  /** 插入请求。 */
  insert(input: NewProvisioningRequestInput): Promise<HostedProvisioningRequestRow>;

  /** 按 ID 读取。 */
  getById(params: { tenantId: string; requestId: string }): Promise<HostedProvisioningRequestRow | null>;

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

  /** 更新状态。 */
  updateState(params: {
    requestId: string;
    state: ProvisioningState;
    currentStep?: string | null;
    attemptCount?: number;
    nextAttemptAt?: Date | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    lastError?: string | null;
    lastAttemptAt?: Date | null;
    /** §6.2: Step Checkpoint 更新。 */
    checkpoint?: StepCheckpoint;
    /** §6.2: 最近完成的步骤。 */
    lastCompletedStep?: string | null;
  }): Promise<HostedProvisioningRequestRow>;

  /** 领取可处理的请求（FOR UPDATE SKIP LOCKED）。 */
  claimRequests(params: {
    workerId: string;
    leaseMs: number;
    batchSize: number;
    now: Date;
  }): Promise<HostedProvisioningRequestRow[]>;

  /** 释放租约。 */
  releaseLease(params: { requestId: string }): Promise<void>;
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

/** §6.2: Step Checkpoint — Saga 每步完成后的产出数据。 */
export interface StepCheckpoint {
  agentRevisionId?: string | null;
  agentPublicationRecordId?: string | null;
  agentAttestationId?: string | null;
  runtimeRevisionId?: string | null;
  runtimePublicationRecordId?: string | null;
  runtimeAttestationId?: string | null;
  conformanceRunId?: string | null;
  routeSetId?: string | null;
  routeSetVersionNo?: number | null;
  routeRevisionId?: string | null;
  routeActivationId?: string | null;
}
