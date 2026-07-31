import { type RuntimeType, runtimeConfig } from "@/lib/config";
import { buildCapability } from "./capability";
import { getDockerAvailable } from "./container/availability";
import { ContainerExecutionRuntime, HostExecutionRuntime } from "./execution-runtime";
import { resolveNetworkPolicy } from "./network-policy";
import { resolveQuota } from "./quota";
import { resolveRuntimeTypeForThread } from "./resolver";
import { type SecretEnvMap, resolveSecrets } from "./secret-mount";
import { isSecretMountAvailable } from "./secret-redaction";
import type { NetworkPolicy, PreviewRuntime, ResourceQuota, RuntimeHandle } from "./types";
import { ContainerWorkspaceStore, HostWorkspaceStore } from "./workspace-store";

function lazyPreviewRuntime(
  kind: "static" | "dev-server",
  defaults?: {
    quota?: ResourceQuota;
    networkPolicy?: NetworkPolicy;
    secretResolver?: () => Promise<SecretEnvMap>;
  },
): PreviewRuntime {
  let loaded: PreviewRuntime | null = null;
  const load = async (): Promise<PreviewRuntime> => {
    if (loaded) return loaded;
    const mod = await import("./preview-runtime");
    loaded =
      kind === "static" ? mod.staticPreviewRuntime : new mod.DevServerPreviewRuntime(defaults);
    return loaded;
  };

  return {
    async start(threadId) {
      return (await load()).start(threadId);
    },
    async stop(threadId) {
      if (!loaded) return;
      await loaded.stop(threadId);
    },
    status(threadId) {
      return loaded?.status(threadId) ?? null;
    },
  };
}

const lazyStaticPreviewRuntime = lazyPreviewRuntime("static");

/**
 * Phase 5 Stage E：runtime 工厂——按 thread + runtimeType 组装三层 runtime 实现。
 *
 * runtimeType 解析优先级（plan §2.7）：
 *   thread.runtimeType → skill_version.runtimeType → 全局默认 `runtimeConfig.defaultType`
 * 由 `resolveRuntimeTypeForThread` 在调用方（chat route，已有 thread + skill 上下文）同步算出，
 * 经 buildTools / reportThreadReady 透传到 resolveRuntimes。默认 host 零回归。
 *
 * 降级：解析出 container 但 docker 不可用（`getDockerAvailable()` false）→ 默认 fail-closed；
 * 仅在 `RUNTIME_DEGRADE_ON_DOCKER_UNAVAILABLE=true` 时降级 host + warn。
 *
 * 预览：container 模式走 DevServerPreviewRuntime（无 dev script 时内部委托 static）；
 * host 模式走 staticPreviewRuntime。
 */

export { resolveRuntimeTypeForThread } from "./resolver";

export function resolveRuntimes(
  threadId: string,
  type?: RuntimeType,
  opts?: {
    quotaOverride?: Partial<ResourceQuota>;
    networkPolicyOverride?: Partial<NetworkPolicy>;
  },
): RuntimeHandle {
  const resolved = type ?? runtimeConfig.defaultType;
  // V3.8：解析 per-thread 配额（全局默认 + thread 覆盖，只能收紧）。
  const quota = resolveQuota({ threadOverride: opts?.quotaOverride });
  // V3.8：解析 per-thread 网络策略（host 恒 open；container 按 config + override）。
  const networkPolicy = resolveNetworkPolicy({
    threadOverride: opts?.networkPolicyOverride,
    runtimeType: resolved,
  });

  // V3.8：secret 解析器（懒加载，首次 exec 时调；master key 缺失时由 resolveSecrets 抛错）
  const secretResolver = isSecretMountAvailable()
    ? () => resolveSecrets(threadId, "thread", threadId)
    : undefined;
  const secretMountAvailable = isSecretMountAvailable();

  if (resolved === "container" && getDockerAvailable()) {
    return {
      workspace: new ContainerWorkspaceStore(threadId),
      execution: new ContainerExecutionRuntime(threadId, quota, networkPolicy, secretResolver),
      preview: lazyPreviewRuntime("dev-server", { quota, networkPolicy, secretResolver }),
      capability: buildCapability({
        runtimeType: "container",
        imageVersion: runtimeConfig.runtimeImage,
        quota,
        networkPolicy,
        secretMount: secretMountAvailable,
      }),
    };
  }

  if (resolved === "container") {
    const msg = `[runtime] thread ${threadId}: runtimeType=container 但 docker 不可用`;
    if (!runtimeConfig.degradeOnDockerUnavailable) {
      throw new Error(`${msg}，拒绝降级 host`);
    }
    console.warn(`${msg}，按配置降级 host`);
  }

  // host 模式（默认或降级）：networkPolicy=open / quotaEnforced=false 诚实标注。
  const isDegraded = resolved === "container" && !getDockerAvailable();
  return {
    workspace: new HostWorkspaceStore(threadId),
    execution: new HostExecutionRuntime(threadId, quota, secretResolver),
    preview: lazyStaticPreviewRuntime,
    capability: buildCapability({
      runtimeType: "host",
      quota,
      available: true,
      secretMount: secretMountAvailable,
      degradedFrom: isDegraded ? "container" : undefined,
      degradedReason: isDegraded ? "docker_unavailable" : undefined,
    }),
  };
}
