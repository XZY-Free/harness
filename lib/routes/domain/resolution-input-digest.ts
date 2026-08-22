import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";

export interface ResolutionInputDigestInput {
  tenantId: string;
  /**
   * 调用方显式提供的可选 Agent 控制面约束（§8.3）。
   *
   * - null = 无 Agent 约束，解析基础 Harness Route。
   * - concrete string = 带 Agent 控制面约束，解析 Agent Route。
   *
   * null 与 concrete 必须产生不同 digest（§8.4），RFC 8785 天然区分。
   * 禁止 undefined / null / empty / "default" 四态模糊：本层统一归一到
   * 明确两态（null = 无约束，或 concrete = 有约束）。
   */
  agentConstraint?: string | null;
  routeScopeKey: string;
  businessKey: { threadId?: string | null; jobId?: string | null };
  attributes: Record<string, unknown>;
  threadDefaultModelRef?: string | null;
}

/**
 * 冻结一次 Route 解析使用的正式输入。
 *
 * 对象遵循 RFC 8785 递归排序，数组保持领域顺序。可选字段 missing 与 null
 * 均归一为 null；attributes 内的 undefined 等非 JSON 值则直接拒绝。
 * agentConstraint 缺失与 null 归一为 null，concrete 保持原值 → 两种状态产生
 * 不同 digest（§8.4）。
 */
export function computeResolutionInputDigest(input: ResolutionInputDigestInput): string {
  return computeCanonicalDigest({
    tenantId: input.tenantId,
    agentConstraint: input.agentConstraint ?? null,
    routeScopeKey: input.routeScopeKey,
    businessKey: {
      threadId: input.businessKey.threadId ?? null,
      jobId: input.businessKey.jobId ?? null,
    },
    attributes: input.attributes,
    threadDefaultModelRef: input.threadDefaultModelRef ?? null,
  });
}
