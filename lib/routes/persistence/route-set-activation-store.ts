import type { DbOrTx } from "@/lib/db/client";
/**
 * RouteSet 整体激活 Store 接口。
 *
 * 支持 ActivateRouteSet 命令的 22 步事务流程。
 */
import type { AuditActor } from "@/lib/identity/audit";
import type { RouteRevisionContent, RouteRevisionTarget } from "@/lib/routes/domain/route-revision";
import type {
  RouteActivationRecord,
  RouteRevisionRecord,
} from "@/lib/routes/persistence/route-revision-record";

// ─── 类型 ──────────────────────────────────────────────────

export type RouteActorType = "user" | "service" | "workload" | "system";

/** RouteSet target 判别联合（专题01 冻结架构）。 */
export type RouteSetTarget = { kind: "runtime" } | { kind: "agent"; agentId: string };

export interface RouteSetRow {
  id: string;
  tenantId: string;
  /** RouteSet 目标判别联合 — runtime 或 agent。不保留 null agentId 表示 runtime 的兼容形状。 */
  target: RouteSetTarget;
  routeScopeKey: string;
  routeScopeJson: unknown;
  versionNo: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RouteRow {
  id: string;
  routeSetId: string;
  /** Route 稳定身份键。 */
  routeKey: string;
  /**
   * 存储列仍为 nullable target-specific（不改变持久化投影列），
   * 但不再作为命令语义暴露 — target 由 RouteRevisionContent.target 决定。
   */
  agentRevisionId: string | null;
  runtimeRevisionId: string | null;
  trafficWeight: number;
  priorityNo: number;
  routeState: "enabled" | "disabled";
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  activeRouteRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRevisionSummary {
  id: string;
  agentId: string;
  revisionState: string;
}

export interface RuntimeRevisionSummary {
  id: string;
  revisionState: string;
}

export interface DesiredRoute {
  routeId?: string;
  /** Route 稳定身份键 — 调用方必须显式指定。 */
  routeKey: string;
  routeGroupId: string;
  /** 判别 target — 只含所选 target 自己的事实。 */
  target: RouteRevisionTarget;
  policyRevisionId?: string | null;
  modelPolicyRevisionId?: string | null;
  toolsetRevisionId?: string | null;
  trafficWeight: number;
  priorityNo: number;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  eligibilityConditions?: Record<string, unknown>;
  activationState?: "active" | "disabled";
}

// ─── Session 接口 ─────────────────────────────────────────

export interface RouteSetActivationSession {
  // ─── 事务连接 ──────────────────────────────────────────
  /** 暴露事务级 DB 连接，确保所有资格读取在同一事务内。 */
  getDbOrTx(): DbOrTx;

  // ─── 读取 ──────────────────────────────────────────────
  /** 按 tenantId + routeSetId 锁定 RouteSet（跨租户隔离）。 */
  lockRouteSet(params: { tenantId: string; routeSetId: string }): Promise<RouteSetRow | null>;
  listRoutesBySet(routeSetId: string): Promise<RouteRow[]>;
  /** 按 ID 读取 RouteRevision；当前激活事实由 Activation 关联确定。 */
  findRevisionById(id: string): Promise<RouteRevisionRecord | null>;
  /** 查找 Route 最新的 Activation（用于填充 previous 字段）。 */
  findLatestActivation(routeId: string): Promise<RouteActivationRecord | null>;
  findAgentRevision(id: string): Promise<AgentRevisionSummary | null>;
  findRuntimeRevision(id: string): Promise<RuntimeRevisionSummary | null>;
  /** 执行资格通过 getDbOrTx 创建的统一 Evidence Reader 判断。 */

  // ─── 写入 ──────────────────────────────────────────────
  resolveOrCreateRouteIdentity(params: {
    routeSetId: string;
    routeId?: string;
    /** Route 稳定身份键 — 用于查找已有 Route。 */
    routeKey: string;
    content: RouteRevisionContent;
    now: Date;
  }): Promise<RouteRow>;
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
    /** Route 稳定身份键 — 派生冗余列。 */
    routeKey: string;
    revisionNo: number;
    content: RouteRevisionContent;
    contentDigest: string;
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
    routeSetId: string;
    activationSequence: number;
    activationState: "active" | "disabled";
    previousRouteRevisionId: string | null;
    /** 前一个 RouteActivation ID — 完整历史链路。 */
    previousRouteActivationId: string | null;
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
  }): Promise<RouteRow>;
  advanceRouteSetVersion(params: {
    routeSetId: string;
    expectedVersionNo: number;
    now: Date;
  }): Promise<RouteSetRow | null>;
  appendAudit(params: {
    id: string;
    tenantId: string;
    actorType: RouteActorType;
    actorId: string;
    actionType: string;
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
    /** 事件类型 — 必须来自合同，aggregateType 由合同推导。 */
    eventType: "route_set.activated" | "route.disabled";
    aggregateId: string;
    /** 聚合版本号。 */
    aggregateVersion: number;
    payload: Record<string, unknown>;
    occurredAt: Date;
  }): Promise<void>;
  completeIdempotency(params: {
    recordId: string;
    tenantId: string;
    commandScope: string;
    httpStatus: number;
    responseRef: string | null;
    responseRedactedJson: string;
    completedAt: Date;
  }): Promise<boolean>;
}

// ─── Store 接口 ───────────────────────────────────────────

export interface RouteSetActivationStore {
  transaction<T>(operation: (session: RouteSetActivationSession) => Promise<T>): Promise<T>;
}
