import { networkPolicyConfig } from "@/lib/config";
import type { NetworkPolicy, NetworkPolicyMode } from "./types";

/**
 * V3.8 Stage B：per-thread 网络策略解析 + docker network 应用。
 *
 * S1 修复（02-P0-2，方案 B）：删除 `allowlist` 模式。原 allowlist 与 disabled 等价却谎报
 * "白名单模式"，契约不兑现。不可绕过的容器 egress 隔离需 iptables/网络插件改造（未实现），
 * 在此之前只保留语义诚实的两态：
 * - `disabled`：完全断网。container 模式 `--network none`。
 * - `open`：不限制。container 模式默认 bridge。
 *
 * host 模式恒为 `open` + `networkPolicyEnforced=false`（平台进程无法硬隔离 egress，不伪装）。
 *
 * 域名级放行由 host 侧平台工具（webFetch/webSearch/searchDocs）各自的 `domainAllowlist`
 * fail-closed 治理负责（空=全 deny），与容器网络模式正交，不在本模块。
 *
 * **DNS 治理边界**（诚实标注，不伪装）：
 * - container `disabled` 模式：`--network none` → 容器内 DNS 不可用（断网即无 DNS 需求）。
 *   白名单域名解析在 host 侧平台工具完成（webFetch 等在 host 解析 DNS 后发请求）。
 * - container `open` 模式：用 docker 默认 bridge DNS（docker 内置 DNS 服务器），不额外治理。
 * - host 模式：用宿主 DNS，平台进程信任，不治理。
 * - **不提供** per-thread 自定义 DNS 服务器 / DNS 白名单 / DNS 劫持——这些需网络层改造，超出应用层范围。
 */

/**
 * 解析 per-thread 网络策略。
 *
 * 继承全局 `networkPolicyConfig.default`。per-thread 覆盖可指定 mode。host 模式恒为 open（不可限制）。
 */
export function resolveNetworkPolicy(opts?: {
  threadOverride?: Partial<NetworkPolicy>;
  runtimeType?: "host" | "container";
}): NetworkPolicy {
  // host 模式恒为 open（信任平台，不可限制 egress）
  if (opts?.runtimeType === "host") {
    return { mode: "open" };
  }

  // P2-9: 运行时枚举校验——TS 类型仅编译时,无效 DB 值(如历史 "allowlist")静默变开放网络。
  // fail-closed:非 disabled/open 一律降级为 disabled(断网)。
  const raw = opts?.threadOverride?.mode ?? networkPolicyConfig.default;
  const mode: NetworkPolicyMode = raw === "open" || raw === "disabled" ? raw : "disabled";
  return { mode };
}

/**
 * 生成 docker `--network` 参数。
 *
 * - `disabled` → `none`（`--network none`，完全断网）
 * - `open` → `undefined`（默认 bridge，不加 `--network`）
 */
export function dockerNetworkMode(policy: NetworkPolicy): string | undefined {
  if (policy.mode === "disabled") return "none";
  return undefined;
}
