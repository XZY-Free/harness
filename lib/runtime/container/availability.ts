import { runtimeConfig } from "@/lib/config";

/**
 * docker 可用性探测。
 *
 * config 零副作用原则下，运行时探测放本模块。`instrumentation.ts` 启动时调一次
 * `warmupDockerAvailable()` 预热缓存并打印诊断；registry 解析 container 模式时同步读
 * `getDockerAvailable()`。container 模式下 docker 不可用时默认 fail-closed；仅当
 * `RUNTIME_DEGRADE_ON_DOCKER_UNAVAILABLE=true` 时允许降级 host。
 *
 * 测试环境默认视 docker 不可用（避免单测误触容器）；可用时由 integration 测试显式预热。
 */

let cached: boolean | null = null;

/** 探测 docker daemon 是否可用（`docker info` 退出 0）。结果缓存。 */
export async function isDockerAvailable(): Promise<boolean> {
  if (cached !== null) return cached;
  if (runtimeConfig.defaultType !== "container") {
    // 默认 host 时无需探测；仅在 container 模式下才真正探测
    cached = false;
    return false;
  }
  try {
    const { execa } = await import("execa");
    const result = await execa("docker", ["info"], {
      reject: false,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    cached = result.exitCode === 0;
  } catch {
    cached = false;
  }
  return cached;
}

/** 同步读缓存（registry 解析用；未预热返回 false）。 */
export function getDockerAvailable(): boolean {
  return cached ?? false;
}

/** instrumentation 启动预热：探测并打印降级 warn。 */
export async function warmupDockerAvailable(): Promise<void> {
  const ok = await isDockerAvailable();
  if (runtimeConfig.defaultType === "container" && !ok) {
    const msg = "[runtime] RUNTIME_DEFAULT=container 但 docker 不可用";
    if (!runtimeConfig.degradeOnDockerUnavailable) {
      throw new Error(`${msg}，且 RUNTIME_DEGRADE_ON_DOCKER_UNAVAILABLE=false，拒绝降级 host`);
    }
    console.warn(`${msg}，按 RUNTIME_DEGRADE_ON_DOCKER_UNAVAILABLE=true 降级 host 模式`);
  } else if (ok) {
    console.log("[runtime] docker 可用，container 模式可按 thread 启用");
  }
}

/** 仅供测试：重置缓存。 */
export function __resetDockerAvailableForTest(): void {
  cached = null;
}

/** 仅供测试：强制设定缓存值。 */
export function __setDockerAvailableForTest(v: boolean): void {
  cached = v;
}
