/**
 * ExecutionSubject— 正式 dispatch contract 的可信调用主体。
 *
 * - Employee Turn 的 subject 必须由服务端认证 Principal 生成；
 * - 禁止从 Turn JSON / 请求体接受 caller 自报 subjectId；
 * - tenant 不可由客户端覆盖；
 * - ExecutionSubject 与 ContextHandle 是两个对象：
 *   ContextHandle 是 Context Gateway 的签名能力句柄，不是用户身份 Token。
 *
 * 公共 wire（05 专项唯一 mapper）：executionSubjectToPublicAgentSubject 输出严格
 * {subject_id, subject_kind: platform_user|platform_service}；旧
 * snowharness.execution_subject namespaced metadata / tenant_id / JSON string
 * serializer 已物理删除，禁止任何第二 Authority。
 */

/** 可信执行主体（服务端权威生成）。 */
export interface ExecutionSubject {
  /** 当前租户（服务端注入，不可由客户端覆盖）。 */
  tenantId: string;
  /** 明确主体类型（user/service 等）。 */
  subjectType: "user" | "service";
  /** SnowHarness 内部稳定主体 ID。 */
  subjectId: string;
}

export const EXECUTION_SUBJECT_SOURCES = ["authenticated_user", "trusted_service"] as const;
export type ExecutionSubjectSource = (typeof EXECUTION_SUBJECT_SOURCES)[number];

/** ExecutionBinding 中唯一、不可变的可信主体事实。tenant 复用 Binding.tenantId。 */
export interface FrozenExecutionSubjectFields {
  executionSubjectType: ExecutionSubject["subjectType"];
  executionSubjectId: string;
  executionSubjectSource: ExecutionSubjectSource;
  executionSubjectFrozenAt: Date;
}

export interface ExecutionSubjectBindingView extends FrozenExecutionSubjectFields {
  tenantId: string;
}

export class TrustedExecutionSubjectError extends Error {
  readonly code = "TRUSTED_EXECUTION_SUBJECT_INVALID";

  constructor(message: string) {
    super(`可信执行主体无效：${message}`);
    this.name = "TrustedExecutionSubjectError";
  }
}

const TERMINAL_EXECUTION_STATES = new Set(["completed", "failed", "cancelled", "lost"]);

/** Dispatcher 唯一冻结入口；不接受空值、跨租户值或来源覆盖。 */
export function freezeTrustedExecutionSubject(
  subject: ExecutionSubject,
  tenantId: string,
  frozenAt: Date = new Date(),
): FrozenExecutionSubjectFields {
  assertTrustedExecutionSubject(subject, tenantId);
  if (!(frozenAt instanceof Date) || Number.isNaN(frozenAt.getTime())) {
    throw new TrustedExecutionSubjectError("冻结时间非法");
  }
  return {
    executionSubjectType: subject.subjectType,
    executionSubjectId: subject.subjectId,
    executionSubjectSource:
      subject.subjectType === "user" ? "authenticated_user" : "trusted_service",
    executionSubjectFrozenAt: frozenAt,
  };
}

/** Gateway、Hosted 恢复和 Worker 共用的唯一恢复入口。 */
export function recoverTrustedExecutionSubject(
  binding: ExecutionSubjectBindingView,
  expectedTenantId: string,
): ExecutionSubject {
  if (!binding || binding.tenantId !== expectedTenantId) {
    throw new TrustedExecutionSubjectError("Binding tenant 与调用租户不一致");
  }
  const subject: ExecutionSubject = {
    tenantId: binding.tenantId,
    subjectType: binding.executionSubjectType,
    subjectId: binding.executionSubjectId,
  };
  assertTrustedExecutionSubject(subject, expectedTenantId);
  const expectedSource: ExecutionSubjectSource =
    subject.subjectType === "user" ? "authenticated_user" : "trusted_service";
  if (binding.executionSubjectSource !== expectedSource) {
    throw new TrustedExecutionSubjectError("主体类型与来源类别不一致");
  }
  if (
    !(binding.executionSubjectFrozenAt instanceof Date) ||
    Number.isNaN(binding.executionSubjectFrozenAt.getTime())
  ) {
    throw new TrustedExecutionSubjectError("Binding 缺少有效冻结时间");
  }
  return subject;
}

/**
 * 迁移判定规则。仅接受关联 Thread 的稳定 owner 或明确的服务创建事实；
 * 非终态无法恢复时阻断，终态历史返回 null 供迁移证据显式处置。
 */
export function recoverTrustedExecutionSubjectForMigration(input: {
  tenantId: string;
  executionState: string;
  threadOwnerUserIdentityId: string | null;
  trustedServiceId: string | null;
}): ExecutionSubject | null {
  if (input.threadOwnerUserIdentityId) {
    return executionSubjectFromUserIdentity(input.tenantId, input.threadOwnerUserIdentityId);
  }
  if (input.trustedServiceId) {
    return executionSubjectFromServiceIdentity(input.tenantId, input.trustedServiceId);
  }
  if (!TERMINAL_EXECUTION_STATES.has(input.executionState)) {
    throw new TrustedExecutionSubjectError("非终态 Binding 无法从权威事实回填");
  }
  return null;
}

export function assertTrustedExecutionSubject(subject: ExecutionSubject, tenantId: string): void {
  if (!subject || subject.tenantId !== tenantId) {
    throw new TrustedExecutionSubjectError("主体 tenant 与 Binding tenant 不一致");
  }
  if (subject.subjectType !== "user" && subject.subjectType !== "service") {
    throw new TrustedExecutionSubjectError("主体类型非法");
  }
  if (typeof subject.subjectId !== "string" || subject.subjectId.trim().length === 0) {
    throw new TrustedExecutionSubjectError("主体 ID 不能为空");
  }
}

/** Agent 公共合同 execution_subject wire 形态（无 tenant，05 §2/§6）。 */
export interface PublicAgentExecutionSubject {
  subject_id: string;
  subject_kind: "platform_user" | "platform_service";
}

/**
 * 唯一公共 mapper：ExecutionSubject → Agent 公共 execution_subject。
 * subjectType→subject_kind 映射只有这一处；输出永不包含 tenant。
 */
export function executionSubjectToPublicAgentSubject(
  subject: ExecutionSubject,
): PublicAgentExecutionSubject {
  return {
    subject_id: subject.subjectId,
    subject_kind: subject.subjectType === "service" ? "platform_service" : "platform_user",
  };
}

/**
 * 从服务端已认证的用户身份生成 trusted ExecutionSubject（Start 与 Resume
 * 共用；只接受服务端 principal / persisted user identity，不接受客户端自报值）。
 */
export function executionSubjectFromUserIdentity(
  tenantId: string,
  userIdentityId: string,
): ExecutionSubject {
  return { tenantId, subjectType: "user", subjectId: userIdentityId };
}

/**
 * 从服务端服务身份生成 trusted ExecutionSubject（平台 workload/service principal）。
 */
export function executionSubjectFromServiceIdentity(
  tenantId: string,
  serviceId: string,
): ExecutionSubject {
  return { tenantId, subjectType: "service", subjectId: serviceId };
}
