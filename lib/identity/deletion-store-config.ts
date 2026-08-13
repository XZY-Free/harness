import type { DeletionStoreAdapter } from "@/lib/identity/deletion-store-adapter";
import { FailClosedDeletionStoreAdapter } from "@/lib/identity/deletion-store-adapter";
/**
 * 跨存储删除 Adapter 的运行时配置入口（S12-W07）。
 *
 * 事实源：docs/architecture/security.md §7
 * （覆盖 MySQL、对象存储、向量/检索、Trace/Log 和缓存；任何外部依赖失败 fail-closed）。
 *
 * 职责：
 * - 为 executor 提供 5 类存储 Adapter 的运行时实例。
 * - 默认 fail-closed：未注入的存储 Adapter 一律抛 DeletionStoreError（不冒充成功）。
 * - 生产环境通过注入真实 Adapter 接入（mysql 走主库、object_storage 走对象存储等）。
 * - 测试环境通过 setDeletionStoreAdaptersOverride 注入 RecordingDeletionStoreAdapter。
 *
 * 安全边界（与 artifact-store-config 对齐）：
 * - 默认 fail-closed：getDeletionStoreAdapter 未命中 override 时返回 FailClosedDeletionStoreAdapter。
 * - Adapter 不可自报 completed；evidenceRef 由存储端产生，executor 校验非空后标记 completed。
 */
import type { DeletionStoreType } from "@/lib/persistence/schema/deletion-request";
import { DELETION_STORE_TYPES } from "@/lib/persistence/schema/deletion-request";

// ─── 单例 + override ──────────────────────────────────────

let adaptersOverride: Map<DeletionStoreType, DeletionStoreAdapter> | null = null;
const defaultAdapters = new Map<DeletionStoreType, DeletionStoreAdapter>();

/**
 * 获取指定存储类型的运行时 Adapter。
 *
 * 优先级：test override > fail-closed 默认。
 * 未注入的存储返回 FailClosedDeletionStoreAdapter（删除一律失败，不冒充成功）。
 */
export function getDeletionStoreAdapter(storeType: DeletionStoreType): DeletionStoreAdapter {
  if (adaptersOverride) {
    const override = adaptersOverride.get(storeType);
    if (override) return override;
  }
  let adapter = defaultAdapters.get(storeType);
  if (!adapter) {
    adapter = new FailClosedDeletionStoreAdapter(storeType);
    defaultAdapters.set(storeType, adapter);
  }
  return adapter;
}

/** 获取全部 5 类存储 Adapter 的映射。 */
export function getAllDeletionStoreAdapters(): ReadonlyMap<
  DeletionStoreType,
  DeletionStoreAdapter
> {
  const result = new Map<DeletionStoreType, DeletionStoreAdapter>();
  for (const storeType of DELETION_STORE_TYPES) {
    result.set(storeType, getDeletionStoreAdapter(storeType));
  }
  return result;
}

// ─── 测试 override API（仅供测试使用）─────────────────────

/**
 * 注入测试用 Adapter 映射（仅供测试使用）。
 * 调用 resetDeletionStoreOverrides 在测试结束后清理。
 */
export function setDeletionStoreAdaptersOverride(
  adapters: Map<DeletionStoreType, DeletionStoreAdapter> | null,
): void {
  adaptersOverride = adapters;
}

/** 清理所有 test override（在 afterEach 中调用）。 */
export function resetDeletionStoreOverrides(): void {
  adaptersOverride = null;
}
