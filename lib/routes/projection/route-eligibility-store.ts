/**
 * RouteEligibilityProjection Store 接口。
 *
 * 只做 Projection 的 CRUD，不做权威事实读取。
 * 权威事实读取由 build-route-eligibility.ts 完成。
 */

import type { RouteEligibilityProjectionRecord } from "./route-eligibility-projection-record";

export interface UpsertProjectionInput {
  routeId: string;
  tenantId: string;
  agentId: string;
  routeSetId: string;
  routeScopeKey: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeRevisionNo: number;
  routeActivationId: string;
  routeActivationSequence: number;
  routeGroupId: string;
  selectorDigest: string;
  eligibilityConditionsJson: unknown;
  specificity: number;
  priorityNo: number;
  trafficWeight: number;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  agentRevisionId: string;
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
  routeContentDigest: string;
  eligibilityState: "eligible" | "ineligible" | "pending_rebuild";
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

  /** 按 RouteRevisionId 查找引用该 Revision 的所有 Projection。 */
  findProjectionsByRevision(revisionId: string): Promise<RouteEligibilityProjectionRecord[]>;

  /** 按 RouteSetId 查找所有 Projection。 */
  findProjectionsByRouteSet(routeSetId: string): Promise<RouteEligibilityProjectionRecord[]>;

  /** 获取当前最大 projectionVersionNo（用于递增）。 */
  getMaxProjectionVersionNo(tenantId: string): Promise<number>;
}
