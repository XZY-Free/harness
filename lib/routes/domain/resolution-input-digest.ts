import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { type RouteTarget, normalizeTarget } from "@/lib/routes/domain/route-resolution-policy";

export interface ResolutionInputDigestInput {
  tenantId: string;
  /** 显式解析目标 — {kind:"runtime"} 或 {kind:"agent", agentId}（Agent 与 Runtime Authority 分离）。 */
  target: RouteTarget;
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
 * target 归一到显式两态（runtime → null，agent → agentId），两种状态产生
 * 不同 digest（§8.4），杜绝隐式 null 模糊。
 */
export function computeResolutionInputDigest(input: ResolutionInputDigestInput): string {
  return computeCanonicalDigest({
    tenantId: input.tenantId,
    target: normalizeTarget(input.target),
    routeScopeKey: input.routeScopeKey,
    businessKey: {
      threadId: input.businessKey.threadId ?? null,
      jobId: input.businessKey.jobId ?? null,
    },
    attributes: input.attributes,
    threadDefaultModelRef: input.threadDefaultModelRef ?? null,
  });
}
