/**
 * Projection-based Route Resolution Store。
 *
 * 从 RouteEligibilityProjection 表一次查询候选。
 * SQL往返≤2，不随Route数量增长。
 * Resolver 纯内存选择，不再N+1查询权威事实。
 */

import type { RouteResolutionCandidate, RouteTarget } from "../domain/route-resolution-policy";

export interface LoadProjectionCandidatesInput {
  tenantId: string;
  /** 显式解析目标 — runtime 查基础 Harness Route，agent 查指定 Agent 的 Route（Agent 与 Runtime Authority）。 */
  target: RouteTarget;
  routeScopeKey: string;
}

export interface RouteEligibilityResolutionStore {
  /**
   * 单次SQL查询从Projection表读取eligible候选。
   * 返回值可直接供 resolveRouteCandidates() 使用。
   */
  loadCandidates(input: LoadProjectionCandidatesInput): Promise<RouteResolutionCandidate[]>;
}
