/**
 * V10 Phase 8：Electron BrowserProfileCleaner 生产实现。
 *
 * 包装 Electron session.fromPartition().clearStorageData()，
 * 实现 BrowserProfileCleaner 接口。
 *
 * 用户退出登录时，遍历所有已注册 userId 的 Browser Profile partition，
 * 调用 clearStorageData 清理 cookies / localStorage / cache / IndexedDB 等持久化数据。
 *
 * 安全约束：
 * - 只清理 persist:snowharness-browser-* partition（由 SessionManager 枚举）
 * - 不清理 App Session（persist:snowharness-app）——那是应用自身的数据
 * - clearStorageData 无选项时清理所有存储类型
 */
import { session } from "electron";
import type { BrowserProfileCleaner } from "./logout-orchestrator";

/**
 * Electron BrowserProfileCleaner 生产实现。
 *
 * 通过 session.fromPartition 获取 Session 实例，
 * 调用 clearStorageData 清理所有持久化数据。
 */
export class ElectronProfileCleaner implements BrowserProfileCleaner {
  /**
   * 清理指定 partition 的所有持久化数据。
   *
   * @param partition Electron session partition 名称（如 persist:snowharness-browser-alice）
   */
  async clearStorageData(partition: string): Promise<void> {
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();
  }
}
