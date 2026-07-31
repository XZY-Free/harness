/**
 * V11 制品存储与 builder 密钥注册表的运行时配置入口（S03-C05）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §4.1-4.2、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §6（artifact-attestations:verify）。
 *
 * 职责：
 * - 为 admin route handler 提供 ManagedArtifactStore 与 BuilderKeyRegistry 的运行时实例。
 * - 生产环境从配置/PolicyRevision 读取（阶段 11 完整接入）；当前阶段提供 in-memory 默认实现。
 * - 测试环境通过 setArtifactStoreOverride / setBuilderKeyRegistryOverride 注入真实密钥与产物。
 *
 * 安全边界：
 * - 默认 in-memory store 为空，任何 verify 调用都会因 readSignatureBundle 抛错而 failed（fail-closed）。
 * - builder 密钥注册表默认为空，任何 builder_identity 都不在白名单（fail-closed）。
 * - override 仅供测试使用；生产环境通过 V11_BUILDER_KEYS_JSON 环境变量注入。
 */
import type {
  BuilderKeyRegistry,
  ManagedArtifactStore,
  ProvenanceDocument,
  SbomDocument,
  SignatureBundle,
} from "@/lib/v11/control-plane/artifact-attestation";

// ─── 默认 in-memory 实现（空 store，fail-closed）──────────

/**
 * 空 ManagedArtifactStore：所有 read 抛错（fail-closed）。
 *
 * 生产环境应替换为真实受管对象存储实现（OCI registry / 对象存储）。
 * 测试环境通过 setArtifactStoreOverride 注入填充了产物的 store。
 */
class EmptyManagedArtifactStore implements ManagedArtifactStore {
  async readSignatureBundle(_ref: string): Promise<SignatureBundle> {
    throw new Error(`EmptyManagedArtifactStore: signature bundle not found: ${_ref}`);
  }
  async readSbom(_ref: string): Promise<SbomDocument> {
    throw new Error(`EmptyManagedArtifactStore: sbom not found: ${_ref}`);
  }
  async readProvenance(_ref: string): Promise<ProvenanceDocument> {
    throw new Error(`EmptyManagedArtifactStore: provenance not found: ${_ref}`);
  }
}

// ─── 单例 + override ──────────────────────────────────────

let storeOverride: ManagedArtifactStore | null = null;
let registryOverride: BuilderKeyRegistry | null = null;
let defaultStore: ManagedArtifactStore | null = null;
let defaultRegistry: BuilderKeyRegistry | null = null;

/**
 * 获取运行时 ManagedArtifactStore。
 *
 * 优先级：test override > 环境变量配置 > 空 store（fail-closed）。
 */
export function getManagedArtifactStore(): ManagedArtifactStore {
  if (storeOverride) return storeOverride;
  if (!defaultStore) {
    // 生产环境从配置读取（阶段 11 接入）；当前阶段使用空 store。
    defaultStore = new EmptyManagedArtifactStore();
  }
  return defaultStore;
}

/**
 * 获取运行时 BuilderKeyRegistry。
 *
 * 优先级：test override > V11_BUILDER_KEYS_JSON 环境变量 > 空注册表（fail-closed）。
 */
export function getBuilderKeyRegistry(): BuilderKeyRegistry {
  if (registryOverride) return registryOverride;
  if (!defaultRegistry) {
    const json = process.env.V11_BUILDER_KEYS_JSON ?? "";
    if (json) {
      try {
        defaultRegistry = JSON.parse(json) as BuilderKeyRegistry;
      } catch {
        defaultRegistry = {};
      }
    } else {
      defaultRegistry = {};
    }
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
