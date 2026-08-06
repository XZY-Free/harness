import { networkPolicyConfig } from "@/lib/config";
import { resolveQuota } from "./quota";
import type { NetworkPolicy, NetworkPolicyMode, ResourceQuota, RuntimeCapability } from "./types";

/**
 * Stage A：Runtime 能力上报。
 *
 * 构建 `RuntimeCapability`——平台审计 + UI 可见 + 部署决策依据。
 *
 * 诚实标注原则（plan §1/）：
 * - host 模式：`networkPolicy=open` / `networkPolicyEnforced=false` / `quotaEnforced=false`。
 * host 是信任平台进程，无法硬隔离 egress 或 cgroup；不伪装有硬隔离。
 * - container 模式：`networkPolicyEnforced=true` / `quotaEnforced=true`。
 * docker network 治理 + cgroup 硬配额（网络策略实现后生效）。
 */

/**
 * 构建 RuntimeCapability。
 *
 * @param opts.runtimeType 解析后的 runtime 类型（host/container）。
 * @param opts.imageVersion container 模式镜像版本（host 无）。
 * @param opts.quota 已解析的 per-thread 配额（含全局默认 + thread 覆盖）。
 * @param opts.secretMount 是否支持 secret 挂载（启用前 false）。
 * @param opts.available runtime 是否可用（container 降级 host 时 false 对 container）。
 */
export function buildCapability(opts: {
 runtimeType: "host" | "container";
 imageVersion?: string;
 quota?: ResourceQuota;
 /** Stage B：已解析的 per-thread 网络策略。 */
 networkPolicy?: NetworkPolicy;
 secretMount?: boolean;
 available?: boolean;
 degradedFrom?: "host" | "container";
 degradedReason?: string;
}): RuntimeCapability {
 const isContainer = opts.runtimeType === "container";
 // 网络策略：container 用已解析策略（或全局默认）；host 恒 open。
 const netPolicy: NetworkPolicyMode = opts.networkPolicy?.mode ?? networkPolicyConfig.default;
 return {
 runtimeType: opts.runtimeType,
 imageVersion: opts.imageVersion,
 networkPolicy: isContainer ? netPolicy : "open",
 // host=false（平台进程无法硬隔离 egress）；container=true（docker network 治理）。
 networkPolicyEnforced: isContainer,
 quotas: opts.quota ?? resolveQuota(),
 // host=false（soft limit，无 cgroup）；container=true（cgroup 硬配额）。
 quotaEnforced: isContainer,
 // 启用前为 false。
 secretMount: opts.secretMount ?? false,
 available: opts.available ?? true,
 degradedFrom: opts.degradedFrom,
 degradedReason: opts.degradedReason,
 };
}

/**
 * host 模式诚实标注：networkPolicy=open / networkPolicyEnforced=false / quotaEnforced=false。
 * 供测试与 UI 验证「不伪装有硬隔离」。
 */
export function isHostHonestlyMarked(cap: RuntimeCapability): boolean {
 if (cap.runtimeType !== "host") return true;
 return (
 cap.networkPolicy === "open" &&
 cap.networkPolicyEnforced === false &&
 cap.quotaEnforced === false
 );
}
