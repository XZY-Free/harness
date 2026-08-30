/**
 * 制品存储与 builder 密钥注册表的运行时配置入口。
 *
 * 事实源：docs/architecture/security.md -4.2、
 * docs/architecture/api-and-events.md §6（artifact-attestations:verify）。
 *
 * 职责：
 * - 为 admin route handler 提供 ManagedArtifactStore 与 BuilderKeyRegistry 的运行时实例。
 * - 测试环境通过 setArtifactStoreOverride / setBuilderKeyRegistryOverride 注入真实密钥与产物。
 *
 * 安全边界：
 * - 未配置 ManagedArtifactStore 时明确失败，不伪装存在空存储实现。
 * - builder 密钥注册表默认为空，任何 builder_identity 都不在白名单（fail-closed）。
 * - override 仅供测试使用；生产环境通过 SNOW_HOSTED_BUILDER_KEYS_JSON 注入。
 */
import type {
  BuilderKeyRegistry,
  ManagedArtifactStore,
} from "@/lib/artifacts/domain/artifact-attestation";
import { hostedControlPlaneConfig } from "@/lib/config";

// ─── 单例 + override ──────────────────────────────────────

let storeOverride: ManagedArtifactStore | null = null;
let registryOverride: BuilderKeyRegistry | null = null;
let defaultRegistry: BuilderKeyRegistry | null = null;

/**
 * 获取运行时 ManagedArtifactStore。
 *
 * 生产调用必须接入真实受管对象存储；测试可注入生产同构的 Store 实现。
 */
export function getManagedArtifactStore(): ManagedArtifactStore {
  if (storeOverride) return storeOverride;
  throw new Error("ManagedArtifactStore 未配置");
}

/**
 * 获取运行时 BuilderKeyRegistry。
 *
 * 优先级：test override > SNOW_HOSTED_BUILDER_KEYS_JSON > 空注册表（fail-closed）。
 */
export function getBuilderKeyRegistry(): BuilderKeyRegistry {
  if (registryOverride) return registryOverride;
  if (!defaultRegistry) {
    defaultRegistry = hostedControlPlaneConfig.builderKeys;
  }
  return defaultRegistry;
}

// ─── 测试 override API（仅供测试使用）─────────────────────

/**
 * 注入测试用 ManagedArtifactStore（仅供测试使用）。
 * 调用 resetArtifactStoreOverrides 在测试结束后清理。
 */
export function setArtifactStoreOverride(store: ManagedArtifactStore | null): void {
  storeOverride = store;
}

/**
 * 注入测试用 BuilderKeyRegistry（仅供测试使用）。
 * 调用 resetArtifactStoreOverrides 在测试结束后清理。
 */
export function setBuilderKeyRegistryOverride(registry: BuilderKeyRegistry | null): void {
  registryOverride = registry;
}

/** 清理所有 test override（在 afterEach 中调用）。 */
export function resetArtifactStoreOverrides(): void {
  storeOverride = null;
  registryOverride = null;
}
