import { type RuntimeType, runtimeConfig } from "@/lib/config";
import { buildCapability } from "./capability";
import { getDockerAvailable } from "./container/availability";
import { ContainerExecutionRuntime, HostExecutionRuntime } from "./execution-runtime";
import { resolveNetworkPolicy } from "./network-policy";
import { resolveQuota } from "./quota";
import { resolveConfiguredRuntimeType } from "./resolver";
import type { NetworkPolicy, PreviewRuntime, ResourceQuota, RuntimeHandle } from "./types";
import { ContainerWorkspaceStore, HostWorkspaceStore } from "./workspace-store";

function lazyPreviewRuntime(
  kind: "static" | "dev-server",
  defaults?: {
    quota?: ResourceQuota;
    networkPolicy?: NetworkPolicy;
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
 * 按平台配置组装本地 Workspace/Execution/Preview Runtime。
 *
 * container 在 Docker 不可用时默认 fail closed；只有显式配置才降级 host。
 * 该本地工具 Runtime 不接受 Thread/Skill/调用方选择，避免形成 Harness Route 之外的执行位置入口。
 */

export { resolveConfiguredRuntimeType } from "./resolver";

export function resolveRuntimes(
  threadId: string,
  opts?: {
    quotaOverride?: Partial<ResourceQuota>;
    networkPolicyOverride?: Partial<NetworkPolicy>;
  },
): RuntimeHandle {
  const resolved: RuntimeType = resolveConfiguredRuntimeType();
  // 解析 per-thread 配额（全局默认 + thread 覆盖，只能收紧）。
  const quota = resolveQuota({ threadOverride: opts?.quotaOverride });
  // 解析 per-thread 网络策略（host 恒 open；container 按 config + override）。
  const networkPolicy = resolveNetworkPolicy({
    threadOverride: opts?.networkPolicyOverride,
    runtimeType: resolved,
  });

  if (resolved === "container" && getDockerAvailable()) {
    return {
      workspace: new ContainerWorkspaceStore(threadId),
      execution: new ContainerExecutionRuntime(threadId, quota, networkPolicy),
      preview: lazyPreviewRuntime("dev-server", { quota, networkPolicy }),
      capability: buildCapability({
        runtimeType: "container",
        imageVersion: runtimeConfig.runtimeImage,
        quota,
        networkPolicy,
        secretMount: false,
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
    execution: new HostExecutionRuntime(threadId, quota),
    preview: lazyStaticPreviewRuntime,
    capability: buildCapability({
      runtimeType: "host",
      quota,
      available: true,
      secretMount: false,
      degradedFrom: isDegraded ? "container" : undefined,
      degradedReason: isDegraded ? "docker_unavailable" : undefined,
    }),
  };
}
