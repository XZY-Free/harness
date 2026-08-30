/**
 * Revision 执行资格唯一跨领域 Reader Port。
 *
 * 只提供两种明确语义：
 * - loadCurrentEvidence(): 读取当前最新证据快照，用于 RouteSet 激活和 Projection 构建
 * - loadExactEvidence(): 读取指定时刻的精确证据快照，用于 ExecutionBinding 验证 Resolver 冻结的证据
 *
 * 不得创建第三套 Reader。
 *
 * 参见：正式架构
 */

import type { RevisionExecutionEvidenceSnapshot } from "../domain/revision-execution-eligibility";

/** 加载 Agent target 证据的输入 — 只含 agentRevisionId，不含 runtimeRevisionId。 */
export interface AgentTargetEvidenceInput {
  kind: "agent";
  tenantId: string;
  /** 绑定的 AgentRevision ID（agent target 恒非空）。 */
  agentRevisionId: string;
  /** Route 引用的 PolicyRevisionId（null = Route 未引用 Policy）。 */
  policyRevisionId: string | null;
}

/** 加载 Runtime target 证据的输入 — 只含 runtimeRevisionId，不含 agentRevisionId。 */
export interface RuntimeTargetEvidenceInput {
  kind: "runtime";
  tenantId: string;
  runtimeRevisionId: string;
  /** Route 引用的 PolicyRevisionId（null = Route 未引用 Policy）。 */
  policyRevisionId: string | null;
}

/** 加载执行资格证据的输入参数 — target 判别联合。 */
export type LoadEvidenceInput = AgentTargetEvidenceInput | RuntimeTargetEvidenceInput;

/** Agent target 精确证据输入 — Resolver 冻结的精确证据引用。 */
export interface AgentTargetExactEvidenceInput extends AgentTargetEvidenceInput {
  /** Resolver 冻结的 ConformanceRun ID（agent target 无 conformance，恒 null）。 */
  conformanceRunId: null;
}

/** Runtime target 精确证据输入 — Resolver 冻结的精确证据引用。 */
export interface RuntimeTargetExactEvidenceInput extends RuntimeTargetEvidenceInput {
  /** Resolver 冻结的 ConformanceRun ID。 */
  conformanceRunId: string | null;
}

/** loadExactEvidence 输入 — target 判别联合 + 精确证据引用。 */
export type LoadExactEvidenceInput =
  | AgentTargetExactEvidenceInput
  | RuntimeTargetExactEvidenceInput;

/**
 * Revision 执行资格证据 Reader 接口。
 *
 * 实现必须：
 * - 真实读取所有证据字段（禁止硬编码）
 * - 使用调用方传入的 DB Session 或 Transaction（禁止内部使用全局 db）
 * - Policy 为 null 仅当 Route 未引用 Policy
 */
export interface RevisionExecutionEvidenceReader {
  /**
   * 读取当前最新执行资格证据快照。
   *
   * 用于 RouteSet 激活和 Projection 构建 — 读取此刻最新的证据状态。
   */
  loadCurrentEvidence(input: LoadEvidenceInput): Promise<RevisionExecutionEvidenceSnapshot>;

  /**
   * 读取指定时刻的精确执行资格证据快照。
   *
   * 用于 ExecutionBinding 验证 — 读取 Resolver 冻结时的精确证据，
   * 特别是使用冻结的 conformanceRunId 而非最新值。
   */
  loadExactEvidence(input: LoadExactEvidenceInput): Promise<RevisionExecutionEvidenceSnapshot>;
}
