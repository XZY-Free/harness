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
  /** null = 基础 Harness Route（无 Agent 资产约束）。 */
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
  /** null = 基础 Harness Route（无 Agent 资产约束）。 */
  agentRevisionId: string | null;
  agentRevisionState: string;
  agentLifecycleState: string;
  agentPublicationActive: number;
  agentEvidenceValid: number;
  runtimeRevisionId: string;
  runtimeRevisionState: string;
  runtimeLifecycleState: string;
  runtimePublicationActive: number;
  runtimeEvidenceValid: number;
  runtimeConformanceValid: number;
  policyRevisionId: string | null;
  policyRevisionState: string | null;
  capabilityCompatibilityDigest: string;
  agentArtifactDigest: string | null;
  runtimeArtifactDigest: string | null;
  runtimeConfigDigest: string | null;
  runtimeTargetDigest: string | null;
  /** Runtime 证据种类（hosted_artifact | external_endpoint — 03 §3）。 */
  runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
  /** Agent Descriptor 证据（Agent Route 必填，base route 为 null — 05 §5）。 */
  agentDescriptorSnapshotId: string | null;
  agentProviderDescriptorDigest: string | null;
  agentInvocationContextContractDigest: string | null;
  routeContentDigest: string;
  // ─── : 完整执行证据 ID ──────────────────────
  agentPublicationRecordId: string | null;
  runtimePublicationRecordId: string | null;
  agentAttestationIds: string[] | null;
  runtimeAttestationIds: string[] | null;
  conformanceRunId: string | null;
  agentArtifactId: string | null;
  runtimeArtifactId: string | null;
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
