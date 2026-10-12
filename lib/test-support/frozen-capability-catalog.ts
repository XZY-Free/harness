/**
 * 冻结能力目录的测试夹具（R01 §5 / R02 §3）。
 *
 * Binding 一旦冻结就不可被当前目录改写；没有任何能力的执行必须是**明确空合同**，
 * 而不是缺失字段。本模块用正式 Builder 生成空目录并给出真实摘要，供测试夹具构造
 * 可被 `verifyCapabilityCatalogSnapshot` 重验通过的 Binding 事实。
 */
import {
  buildCapabilityCatalogSnapshot,
  computeCapabilityCatalogDigest,
} from "@/lib/runtime/harness-loop/capability-catalog";

export interface FrozenCapabilityCatalogFixture {
  capabilityCatalogJson: unknown;
  capabilityCatalogDigest: string;
  capabilityCatalogVersion: string;
  capabilityCatalogSourceRefs: string[];
  capabilityCatalogCreatedAt: Date;
}

/**
 * 生成"明确无能力"的冻结目录事实。
 *
 * - `sourceRefs` 显式记录来源，便于审计"为何为空"；
 * - digest 由规范摘要计算，与 `capabilityCatalogJson` 自洽。
 */
export function frozenCapabilityCatalogForInvocation(
  invocationId: string,
  sourceRefs: string[] = [],
  now: Date = new Date(),
): FrozenCapabilityCatalogFixture {
  const built = buildCapabilityCatalogSnapshot({
    invocationId,
    preferredAgentId: null,
    agentCandidate: null,
    sourceRefs,
    tools: [],
    knowledgeSources: [],
    unavailableFacts: [],
    now,
  });
  return {
    capabilityCatalogJson: built.snapshot,
    capabilityCatalogDigest: computeCapabilityCatalogDigest(built.snapshot),
    capabilityCatalogVersion: built.version,
    capabilityCatalogSourceRefs: [...built.sourceRefs],
    capabilityCatalogCreatedAt: built.createdAt,
  };
}
