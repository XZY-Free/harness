import type { RouteResolutionCandidate } from "../domain/route-resolution-policy";

export interface LoadRouteResolutionCandidatesInput {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
}

export interface RouteResolutionStore {
  loadCandidates(input: LoadRouteResolutionCandidatesInput): Promise<RouteResolutionCandidate[]>;
}
