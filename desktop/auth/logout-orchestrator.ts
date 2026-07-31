/**
 * V10 Phase 8：退出登录编排。
 *
 * 协调退出登录时的资源清理顺序：
 * 1. 断开 Agent Bridge WebSocket（停止 RPC 通信）
 * 2. 清理 Browser Profile 持久化数据（cookies / localStorage / cache）
 * 3. 清理 Keychain 中的设备身份（私钥 + 设备 ID）
 *
 * 设计原则：
 * - 每一步失败不阻断后续步骤（best-effort 清理）
 * - 返回各步骤的成功状态，便于 UI 展示清理结果
 * - 不依赖 electron API（通过依赖注入），便于单元测试
 *
 * 注意：此模块只编排 Desktop 本地清理。Server 端的设备撤销需要单独
 * 通过 HTTP revoke API 触发（app/api/desktop/devices/[deviceId]/revoke）。
 */
import type { BridgeClient } from "../bridge/bridge-client";
import { clearDeviceIdentity } from "../bridge/device-identity";
import type { SessionManager } from "../browser/session-manager";
import type { KeychainAdapter } from "../storage/keychain";

/**
 * Browser Profile 清理接口（由 Electron 生产实现注入，避免本模块直接依赖 electron）。
 */
export interface BrowserProfileCleaner {
  /** 清理指定 partition 的所有持久化数据（cookies / localStorage / cache / storage） */
  clearStorageData(partition: string): Promise<void>;
}

/**
 * 退出登录清理结果。
 */
export interface LogoutResult {
  /** Bridge 断开是否成功 */
  bridgeDisconnected: boolean;
  /** Browser Profile 清理的 partition 数量 */
  browserProfilesCleared: number;
  /** 设备身份清理是否成功 */
  identityCleared: boolean;
  /** 整体是否全部成功 */
  ok: boolean;
}

/**
 * Phase 8：执行退出登录清理。
 *
 * @param bridgeClient Agent Bridge 客户端（可选，未连接时跳过断开步骤）
 * @param sessionManager Session 管理器（用于枚举已注册 userId）
 * @param profileCleaner Browser Profile 清理器（Electron session API 封装）
 * @param keychain Keychain 适配器
 * @returns 各步骤清理结果
 */
export async function performLogout(
  bridgeClient: BridgeClient | null,
  sessionManager: SessionManager,
  profileCleaner: BrowserProfileCleaner,
  keychain: KeychainAdapter,
): Promise<LogoutResult> {
  let bridgeDisconnected = false;
  let browserProfilesCleared = 0;
  let identityCleared = false;

  // 步骤 1：断开 Agent Bridge WebSocket
  // 失败不阻断后续清理
  try {
    if (bridgeClient) {
      bridgeClient.disconnect();
    }
    bridgeDisconnected = true;
  } catch {
    // 断开失败静默忽略——可能 WS 已断开
  }

  // 步骤 2：清理 Browser Profile 持久化数据
  // 枚举所有已注册 userId，逐个清理 partition
  // 失败不阻断后续清理
  const userIds = sessionManager.getUserIds();
  for (const userId of userIds) {
    const partition = sessionManager.getOrCreateBrowserPartition(userId);
    try {
      await profileCleaner.clearStorageData(partition);
      browserProfilesCleared += 1;
    } catch {
      // 清理失败静默忽略——可能 partition 不存在
    }
    // 从内存映射中移除
    sessionManager.removeBrowserProfile(userId);
  }

  // 步骤 3：清理 Keychain 中的设备身份
  // 失败不阻断返回——但 ok 会反映失败
  try {
    await clearDeviceIdentity(keychain);
    identityCleared = true;
  } catch {
    // Keychain 清理失败静默忽略——可能 Keychain 不可用
  }

  return {
    bridgeDisconnected,
    browserProfilesCleared,
    identityCleared,
    ok: bridgeDisconnected && identityCleared,
  };
}
