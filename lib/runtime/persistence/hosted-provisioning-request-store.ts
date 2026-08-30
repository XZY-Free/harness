/**
 * HostedProvisioningRequest Store 接口。
 *
 * Runtime-only Authority：身份权威 (tenantId, routeScopeKey)。
 * - insert 携带非空 requesterId，无 Agent 字段、无可选 desiredRuntimeKey。
 * - findActiveRequest 只按 (tenantId, routeScopeKey) 幂等。
 * - 已删除 findReadyByAgent（Agent 黑盒 A2A，Hosted 不按 Agent 查 ready 请求）。
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

  /** 按 (tenantId, routeScopeKey) 查找活跃请求（幂等权威）。 */
  findActiveRequest(params: {
    tenantId: string;
    routeScopeKey: string;
  }): Promise<HostedProvisioningRequestRow | null>;

  /** 更新状态。: 必须提供 workerId 进行 lease owner 校验。 */
  updateState(params: {
    requestId: string;
    /** Lease Owner 校验 — WHERE leaseOwner = workerId。 */
    workerId: string;
    state: ProvisioningState;
    currentStep?: string | null;
    attemptCount?: number;
    nextAttemptAt?: Date | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    lastError?: string | null;
    lastAttemptAt?: Date | null;
    /** Step Checkpoint 更新（runtime/route；不含 Agent）。 */
    checkpoint?: StepCheckpoint;
    /** 最近完成的步骤。 */
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
  requesterId: string;
  routeScopeKey: string;
  state?: ProvisioningState;
  createdAt: Date;
  updatedAt: Date;
}

/** Step Checkpoint — Saga 每步完成后的产出数据（runtime/route；不含 Agent）。 */
export interface StepCheckpoint {
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
