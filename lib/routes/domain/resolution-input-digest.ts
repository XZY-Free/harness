import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";

export interface ResolutionInputDigestInput {
  tenantId: string;
  agentId: string;
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
 */
export function computeResolutionInputDigest(input: ResolutionInputDigestInput): string {
  return computeCanonicalDigest({
    tenantId: input.tenantId,
    agentId: input.agentId,
    routeScopeKey: input.routeScopeKey,
    businessKey: {
      threadId: input.businessKey.threadId ?? null,
      jobId: input.businessKey.jobId ?? null,
    },
    attributes: input.attributes,
    threadDefaultModelRef: input.threadDefaultModelRef ?? null,
  });
}
