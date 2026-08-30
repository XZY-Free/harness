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
