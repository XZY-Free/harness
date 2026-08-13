/**
 * Projection-based Route Resolution Store。
 *
 * 从 RouteEligibilityProjection 表一次查询候选。
 * SQL往返≤2，不随Route数量增长。
 * Resolver 纯内存选择，不再N+1查询权威事实。
 */

import type { RouteResolutionCandidate } from "../domain/route-resolution-policy";

export interface LoadProjectionCandidatesInput {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
}

export interface RouteEligibilityResolutionStore {
  /**
   * 单次SQL查询从Projection表读取eligible候选。
   * 返回值可直接供 resolveRouteCandidates() 使用。
   */
  loadCandidates(input: LoadProjectionCandidatesInput): Promise<RouteResolutionCandidate[]>;
}
