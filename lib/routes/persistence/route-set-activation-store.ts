import type { DbOrTx } from "@/lib/db/client";
/**
 * RouteSet 整体激活 Store 接口。
 *
 * 支持 ActivateRouteSet 命令的 22 步事务流程。
 */
import type { AuditActor } from "@/lib/identity/audit";
import type { RouteRevisionContent } from "@/lib/routes/domain/route-revision";
import type {
  RouteActivationRecord,
  RouteRevisionRecord,
} from "@/lib/routes/persistence/route-revision-record";

// ─── 类型 ──────────────────────────────────────────────────

export type RouteActorType = "user" | "service" | "workload" | "system";

export interface RouteSetRow {
  id: string;
  tenantId: string;
  /** null = 基础 Harness RouteSet（无 Agent 资产约束）。 */
  agentId: string | null;
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
  /** 无 Agent 约束（基础 Harness Route）为 null。 */
  agentRevisionId: string | null;
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

export interface AgentRevisionSummary {
  id: string;
  agentId: string;
  revisionState: string;
  requiredCapabilities: string[];
}

export interface RuntimeRevisionSummary {
  id: string;
  revisionState: string;
  capabilities: string[];
}

export interface DesiredRoute {
  routeId?: string;
  /** Route 稳定身份键 — 调用方必须显式指定。 */
  routeKey: string;
  routeGroupId: string;
  /**
   * 绑定的 AgentRevision ID。
   * null = 基础 Harness Route（无 Agent 资产约束）；有值 = Agent Route。
   */
  agentRevisionId: string | null;
  runtimeRevisionId: string;
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
