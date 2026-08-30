/**
 * RouteEligibilityProjection Store 接口。
 *
 * 只做 Projection 的 CRUD，不读取权威事实。
 * 权威事实读取由 RouteEligibilitySourceReader 完成。
 */

import type { RouteEligibilityProjectionRecord } from "./route-eligibility-projection-record";

export interface UpsertProjectionInput {
  routeId: string;
  tenantId: string;
  /** 显式目标类型 — runtime 或 agent（冻结架构，无默认）。 */
  targetKind: "runtime" | "agent";
  /**
   * 目标唯一身份：
   * - runtime：固定 "runtime"。
   * - agent：= agentId。
   * 与 targetKind/agentId 一致由 DB CHECK 保证。
   */
  targetIdentity: string;
  /** runtime 时为 null；agent 时非空且 = targetIdentity。 */
  agentId: string | null;
  routeSetId: string;
  routeScopeKey: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeRevisionNo: number;
  routeActivationId: string;
  routeActivationSequence: number;
  activationState: "active" | "disabled";
  routeGroupId: string;
  selectorDigest: string;
  eligibilityConditionsJson: unknown;
  specificity: number;
  priorityNo: number;
  trafficWeight: number;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  /** agent target 非空；runtime target 必须 null（组互斥由 DB CHECK 保证）。 */
  agentRevisionId: string | null;
  // ─── Agent Route 生产调用事实──
  agentEndpointRef: string | null;
  agentIdentityMode: "none" | "bearer" | null;
  agentCredentialRefId: string | null;
  agentNetworkZone: string | null;
  agentRevisionState: string | null;
  agentLifecycleState: string | null;
  agentPublicationActive: number | null;
  agentEvidenceValid: number | null;
  agentPublicationRecordId: string | null;
  agentContractSnapshotId: string | null;
  agentContractDigest: string | null;
  agentContextDigest: string | null;
  // ─── Runtime 侧资格 ─────────────────────────
  runtimeRevisionId: string | null;
  runtimeRevisionState: string | null;
  runtimeLifecycleState: string | null;
  runtimePublicationActive: number | null;
  runtimeEvidenceValid: number | null;
  runtimeConformanceValid: number | null;
  runtimeEvidenceKind: "hosted_artifact" | "external_endpoint" | null;
  runtimePublicationRecordId: string | null;
  runtimeAttestationIds: string[] | null;
  conformanceRunId: string | null;
  runtimeArtifactId: string | null;
  runtimeArtifactDigest: string | null;
  runtimeConfigDigest: string | null;
  runtimeTargetDigest: string | null;
  /** 兼容性摘要 — 仅 runtime target 计算；agent target null。 */
  capabilityCompatibilityDigest: string | null;
  // ─── Policy（公共语义）───────────────
  policyRevisionId: string | null;
  policyRevisionState: string | null;
  routeContentDigest: string;
  sourceEventId: string | null;
  sourceAggregateVersion: number | null;
  invalidReason: string | null;
  eligibilityState: "eligible" | "ineligible" | "pending_rebuild";
  /** 投影内容摘要 — 用于幂等版本判断。 */
  projectionContentDigest: string;
  projectionVersionNo: number;
  lastRebuiltAt: Date;
}

export interface RouteEligibilityStore {
  /** 创建或更新 Projection（UPSERT by routeId PK）。 */
  upsertProjection(input: UpsertProjectionInput): Promise<RouteEligibilityProjectionRecord>;

  /** 按 routeId 获取 Projection。 */
  getProjectionByRoute(routeId: string): Promise<RouteEligibilityProjectionRecord | null>;

  /** 列出符合条件的 eligible 投影 — Resolver 单次查询。 */
  listEligibleProjections(input: {
    tenantId: string;
    agentId: string;
    routeScopeKey: string;
  }): Promise<RouteEligibilityProjectionRecord[]>;

  /** 标记单个 Route 为 ineligible。 */
  markIneligible(routeId: string, reason: string): Promise<void>;

  /** 标记单个 Route 为 pending_rebuild。 */
  markPendingRebuild(routeId: string): Promise<void>;

  /** 删除 Projection 行（Route/RouteSet 删除时清理孤立投影）。 */
  deleteProjection(routeId: string): Promise<void>;

  /** 删除 RouteSet 下所有 Projection。 */
  deleteProjectionsByRouteSet(routeSetId: string): Promise<void>;

  /** 列出所有投影 routeId（全量重建用）。 */
  listAllProjectionRouteIds(): Promise<Array<{ routeId: string }>>;

  /** 按 routeSetId 列出投影 routeId（全量重建用）。 */
  listProjectionRouteIdsByRouteSet(routeSetId: string): Promise<Array<{ routeId: string }>>;
}
