/**
 * ExecutionSubject（06 §6）— 正式 dispatch contract 的可信调用主体。
 *
 * - Employee Turn 的 subject 必须由服务端认证 Principal 生成；
 * - 禁止从 Turn JSON / 请求体接受 caller 自报 subjectId；
 * - tenant 不可由客户端覆盖；
 * - ExecutionSubject 与 ContextHandle 是两个对象（06 §8）：
 *   ContextHandle 是 Context Gateway 的签名能力句柄，不是用户身份 Token。
 *
 * Transport 映射（06 §7）：
 * - Agent Runtime Protocol：dispatch envelope 增加 execution subject；
 * - A2A：冻结 namespaced metadata（snowharness.execution_subject）发送，
 *   SnowHarness 不假设对方如何把 subjectId 映射到其内部员工/客户 ID。
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

/** wire 形态（snake_case，进入 dispatch envelope / A2A metadata）。 */
export interface ExecutionSubjectWire {
  tenant_id: string;
  subject_type: string;
  subject_id: string;
}

/** 校验 wire 形态（Transport 入口 fail-closed）。 */
export function isValidExecutionSubjectWire(value: unknown): value is ExecutionSubjectWire {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tenant_id === "string" &&
    record.tenant_id.length > 0 &&
    typeof record.subject_type === "string" &&
    record.subject_type.length > 0 &&
    typeof record.subject_id === "string" &&
    record.subject_id.length > 0
  );
}

/** 转换为 A2A namespaced metadata value（06 §7 冻结命名空间）。 */
export const A2A_EXECUTION_SUBJECT_METADATA_KEY = "snowharness.execution_subject";

/** 序列化为 A2A metadata value（JSON 字符串，供远端按合同解析）。 */
export function executionSubjectToA2AMetadata(subject: ExecutionSubject): string {
  return JSON.stringify({
    tenant_id: subject.tenantId,
    subject_type: subject.subjectType,
    subject_id: subject.subjectId,
  });
}
