/**
 * 审计账本守卫。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §8、
 *         ../v11-agentkit-platform-development-plan/02-identity-authorization-and-common-ledgers.md S02-W05。
 *
 * 行为：
 * - 发布、路由、策略、授权、Credential、删除、Legal Hold、隔离事件处理、诊断内容查看和导出均写审计。
 * - Audit 记录 actor、action、target、before/after hash、reason 和 request id，不复制无关聊天正文。
 * - Audit 只追加（appendAuditEvent 不提供 update/delete）；依法清理走后续数据生命周期流程。
 *
 * 守卫入口 recordAuditEvent：
 * - 从员工主体或 Workload 主体提取 actor（与幂等账本 caller 对齐）。
 * - 校验 actionType 在 AUDIT_ACTION_TYPES 目录中（fail-closed，未知动作拒绝写入）。
 * - 调用方传入 before/after 内容或其 hash；本模块只做 hash 计算与写入。
 */
import { createHash } from "node:crypto";
import { generateRequestId } from "@/lib/http";
import { appendAuditEvent } from "@/lib/identity/audit-queries";
import {
  AUDIT_ACTION_TYPES,
  type AuditActorType,
  type AuditEvent,
} from "@/lib/persistence/schema/control-plane";

interface EmployeePrincipal {
  tenantId: string;
  userIdentityId: string;
}

interface WorkloadPrincipal {
  tenantId: string;
  callerType: string;
  serviceId: string | null;
  invocationId: string | null;
}

/** 审计执行者（与 idempotency caller 对齐，但用 actorType 语义）。 */
export interface AuditActor {
  tenantId: string;
  actorType: AuditActorType;
  actorId: string;
}

/** 审计事件写入参数。 */
export interface RecordAuditEventParams {
  actor: AuditActor;
  actionType: string;
  targetType: string;
  targetId?: string | null;
  /** 变更前内容（明文）；本模块计算 hash，不存原文。 */
  before?: unknown;
  /** 变更后内容（明文）；本模块计算 hash，不存原文。 */
  after?: unknown;
  /** 已计算好的 beforeHash；优先于 before。 */
  beforeHash?: string | null;
  /** 已计算好的 afterHash；优先于 after。 */
  afterHash?: string | null;
  reason?: string | null;
  /** 关联请求 id；缺省由平台生成。 */
  requestId?: string;
  occurredAt?: Date;
}

/**
 * 审计守卫入口：写入不可修改审计事件。
 *
 * 校验：
 * - actionType 必须在 AUDIT_ACTION_TYPES 目录中（fail-closed）。
 * - before/beforeHash 至少其一非空时计算 beforeHash；after/afterHash 同理。
 *
 * @throws AuditActionTypeError actionType 未知
 */
export async function recordAuditEvent(params: RecordAuditEventParams): Promise<AuditEvent> {
  assertAuditActionTypeKnown(params.actionType);

  const beforeHash = resolveHash(params.beforeHash, params.before);
  const afterHash = resolveHash(params.afterHash, params.after);
  const requestId = params.requestId ?? generateRequestId();

  return appendAuditEvent({
    tenantId: params.actor.tenantId,
    actorType: params.actor.actorType,
    actorId: params.actor.actorId,
    actionType: params.actionType,
    targetType: params.targetType,
    targetId: params.targetId ?? null,
    beforeHash,
    afterHash,
    reason: params.reason ?? null,
    requestId,
    occurredAt: params.occurredAt,
  });
}

/** 系统级审计（如 Event Projection 自动处理隔离事件）：actorType=system。 */
export async function recordSystemAuditEvent(params: {
  tenantId: string;
  /** 系统组件名，如 "event_projection"、"retention_scheduler"。 */
  systemComponent: string;
  actionType: string;
  targetType: string;
  targetId?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
  reason?: string | null;
  requestId?: string;
  occurredAt?: Date;
}): Promise<AuditEvent> {
  return recordAuditEvent({
    actor: {
      tenantId: params.tenantId,
      actorType: "system",
      actorId: params.systemComponent,
    },
    actionType: params.actionType,
    targetType: params.targetType,
    targetId: params.targetId,
    beforeHash: params.beforeHash,
    afterHash: params.afterHash,
    reason: params.reason,
    requestId: params.requestId,
    occurredAt: params.occurredAt,
  });
}

/** 从员工 Session 主体提取审计执行者。 */
export function actorFromPrincipal(principal: EmployeePrincipal): AuditActor {
  return {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.userIdentityId,
  };
}

/**
 * 从 runtime/gateway/admin Service/Workload Token 主体提取审计执行者。
 *
 * - service → actorId = serviceId
 * - workload（runtime/gateway）→ actorId = invocationId
 *
 * @throws service 缺失 serviceId 或 runtime/gateway 缺失 invocationId 时抛错
 */
export function actorFromWorkloadPrincipal(principal: WorkloadPrincipal): AuditActor {
  if (principal.callerType === "service") {
    if (!principal.serviceId) {
      throw new Error("actorFromWorkloadPrincipal: service Token 缺失 serviceId");
    }
    return {
      tenantId: principal.tenantId,
      actorType: "service",
      actorId: principal.serviceId,
    };
  }
  if (principal.callerType === "workload") {
    if (!principal.invocationId) {
      throw new Error("actorFromWorkloadPrincipal: runtime/gateway Token 缺失 invocationId");
    }
    return {
      tenantId: principal.tenantId,
      actorType: "workload",
      actorId: principal.invocationId,
    };
  }
  throw new Error(
    `actorFromWorkloadPrincipal: 不支持的 callerType=${principal.callerType as string}`,
  );
}

/** 计算内容 sha256 hex（用于 before/after hash）。null/undefined 返回 null（创建/删除操作）。 */
export function computeContentHash(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  const json = JSON.stringify(sortKeys(content));
  return createHash("sha256").update(json, "utf-8").digest("hex");
}

/** 判断 actionType 是否在 AUDIT_ACTION_TYPES 目录中。 */
export function isKnownAuditActionType(actionType: string): boolean {
  return (AUDIT_ACTION_TYPES as readonly string[]).includes(actionType);
}

/** 校验 actionType 已知；未知抛错（fail-closed）。 */
export function assertAuditActionTypeKnown(actionType: string): void {
  if (!isKnownAuditActionType(actionType)) {
    throw new AuditActionTypeError(actionType);
  }
}

/** 未知审计动作类型错误（调用方应映射为 400 REQUEST_SCHEMA_INVALID 或 500）。 */
export class AuditActionTypeError extends Error {
  constructor(public readonly actionType: string) {
    super(`未知审计动作类型: ${actionType}`);
    this.name = "AuditActionTypeError";
  }
}

/** 解析 hash：优先用显式 hash，否则从内容计算。 */
function resolveHash(explicitHash: string | null | undefined, content: unknown): string | null {
  if (explicitHash !== undefined) return explicitHash;
  return computeContentHash(content);
}

/** 递归排序 object 的 key（与 computeRequestHash 一致，保证 hash 稳定）。 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}
