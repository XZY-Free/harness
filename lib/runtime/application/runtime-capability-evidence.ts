/**
 * Runtime 能力摘要的唯一比对源（R02 §3）。
 *
 * 冻结不变量：**发布证据是唯一比对源**。expected capability digest 只能从
 * Binding 冻结的 RuntimeRevision（`runtimeRevisionId` + `runtimeCapabilitiesJson`）
 * 计算，并在发 Start 之前随 Session 一起持久化（Session 同时持有这两项，因此
 * 该摘要始终可由持久事实重算，不需要任何内存状态）。
 *
 * 三方必须对同一摘要校验：
 * 1. Runtime 的 HTTP 接纳回执（`RuntimeStartResponse.capabilitiesDigest`）；
 * 2. ACK 之前到达的 `execution.started` 回调；
 * 3. In-process Hosted 的接纳回执（不再有"零摘要 / in-process 免校验"分支）。
 */
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";

export interface FrozenCapabilityEvidence {
  runtimeRevisionId: string;
  runtimeCapabilitiesJson: unknown;
}

/** 从冻结发布事实计算 expected capability digest。 */
export function expectedCapabilityManifestDigest(input: FrozenCapabilityEvidence): string {
  return computeCapabilityManifestDigest({
    runtimeRevisionId: input.runtimeRevisionId,
    runtimeCapabilities: input.runtimeCapabilitiesJson,
  });
}
