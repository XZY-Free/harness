import type { RouteRevisionContent } from "../domain/route-revision";
import type { RouteActivationRecord, RouteRevisionRecord } from "./route-revision-record";

export type RouteActorType = "user" | "service" | "workload" | "system";

export interface RouteSetProjection {
  id: string;
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
  routeScopeJson: unknown;
  versionNo: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RouteProjection {
  id: string;
  routeSetId: string;
  agentRevisionId: string;
  runtimeRevisionId: string;
  trafficWeight: number;
  priorityNo: number;
  routeState: "enabled" | "disabled";
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  activeRouteRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublishedAgentRevision {
  id: string;
  agentId: string;
  revisionState: string;
  requiredCapabilities: string[];
}

export interface PublishedRuntimeRevision {
  id: string;
  revisionState: string;
  capabilities: string[];
}

export interface RouteControlSession {
  lockRouteSet(tenantId: string, routeSetId: string): Promise<RouteSetProjection | null>;
  resolveRouteIdentity(params: {
    routeId?: string;
    routeSetId: string;
    content: RouteRevisionContent;
    now: Date;
  }): Promise<RouteProjection>;
  findActivationByIdempotency(
    routeId: string,
    idempotencyKey: string,
  ): Promise<{ revision: RouteRevisionRecord; activation: RouteActivationRecord } | null>;
  findAgentRevision(id: string): Promise<PublishedAgentRevision | null>;
  findRuntimeRevision(id: string): Promise<PublishedRuntimeRevision | null>;
  hasVerifiedAttestation(params: {
    tenantId: string;
    artifactType: "agent_revision" | "runtime_revision";
    revisionId: string;
  }): Promise<boolean>;
  findRevisionByContent(
    routeId: string,
    contentDigest: string,
  ): Promise<RouteRevisionRecord | null>;
  nextRevisionNo(routeId: string): Promise<number>;
  appendRevision(params: {
    id: string;
    tenantId: string;
    routeId: string;
    routeSetId: string;
    revisionNo: number;
    content: RouteRevisionContent;
    contentDigest: string;
    /** Selector Digest — 由 RouteSelector.computeSelectorDigest 规范化计算。null 仅在 Eligibility 无法规范化时出现。 */
    selectorDigest: string | null;
    actorType: RouteActorType;
    actorId: string;
    now: Date;
  }): Promise<RouteRevisionRecord>;
  nextActivationSequence(routeId: string): Promise<number>;
  appendActivation(params: {
    id: string;
    tenantId: string;
    routeId: string;
    routeRevisionId: string;
    /** 派生冗余列 — 始终 = 对应 RouteRevision.routeSetId，写入服务负责派生和断言。 */
    routeSetId: string;
    activationSequence: number;
    activationState: "active" | "disabled";
    previousRouteRevisionId: string | null;
    routeSetVersionNo: number;
    actorType: RouteActorType;
    actorId: string;
    reason: string;
    requestId: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<RouteActivationRecord>;
  updateRouteProjection(params: {
    routeId: string;
    revision: RouteRevisionRecord;
    routeState: "enabled" | "disabled";
    now: Date;
  }): Promise<RouteProjection>;
  advanceRouteSetVersion(params: {
    routeSetId: string;
    expectedVersionNo: number;
    now: Date;
  }): Promise<RouteSetProjection | null>;
  appendAudit(params: {
    id: string;
    tenantId: string;
    actorType: RouteActorType;
    actorId: string;
    actionType: "route.revision.create" | "route.update";
    routeId: string;
    after: unknown;
    reason: string;
    requestId: string;
    occurredAt: Date;
  }): Promise<void>;
  appendOutbox(params: {
    id: string;
    tenantId: string;
    eventKey: string;
    eventType: "route.revision.validated" | "route.activated" | "route.disabled";
    routeId: string;
    payload: unknown;
    occurredAt: Date;
  }): Promise<void>;
  completeIdempotency(params: {
    recordId: string;
    httpStatus: number;
    responseRef: string | null;
    responseRedactedJson: string;
    completedAt: Date;
  }): Promise<boolean>;
}

export interface RouteControlStore {
  transaction<T>(operation: (session: RouteControlSession) => Promise<T>): Promise<T>;
}
