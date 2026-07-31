/**
 * V10 Phase 8：退出登录编排测试。
 *
 * 验证清理顺序和 best-effort 语义：
 * - 正常流程：Bridge 断开 + Profile 清理 + 身份清理 全部成功
 * - BridgeClient 为 null 时跳过断开步骤
 * - Profile 清理失败不阻断后续清理
 * - Keychain 清理失败时 ok=false 但其他步骤仍执行
 * - 多个 userId 全部清理
 * - SessionManager.removeBrowserProfile 被调用
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/bridge-client";
import type { SessionManager } from "../browser/session-manager";
import type { KeychainAdapter } from "../storage/keychain";
import { type BrowserProfileCleaner, performLogout } from "./logout-orchestrator";

/** 内存 KeychainAdapter */
class MemoryKeychain implements KeychainAdapter {
  private store = new Map<string, string>();
  available = true;

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  isAvailable(): boolean {
    return this.available;
  }
}

/** Mock SessionManager */
function makeMockSessionManager(userIds: string[]): SessionManager {
  return {
    getUserIds: vi.fn(() => userIds),
    getOrCreateBrowserPartition: vi.fn((userId: string) => `persist:snowharness-browser-${userId}`),
    removeBrowserProfile: vi.fn(() => true),
  } as unknown as SessionManager;
}

/** Mock BridgeClient */
function makeMockBridgeClient(disconnectShouldThrow = false): BridgeClient {
  const disconnect = vi.fn();
  if (disconnectShouldThrow) {
    disconnect.mockImplementation(() => {
      throw new Error("disconnect failed");
    });
  }
  return { disconnect } as unknown as BridgeClient;
}

/** Mock BrowserProfileCleaner */
function makeMockProfileCleaner(shouldFail = false): BrowserProfileCleaner {
  const clearStorageData = vi.fn();
  if (shouldFail) {
    clearStorageData.mockRejectedValue(new Error("clearStorageData failed"));
  } else {
    clearStorageData.mockResolvedValue(undefined);
  }
  return { clearStorageData };
}

describe("performLogout (Phase 8)", () => {
  it("正常流程：Bridge 断开 + Profile 清理 + 身份清理 全部成功", async () => {
    const bridgeClient = makeMockBridgeClient();
    const sessionManager = makeMockSessionManager(["u1"]);
    const profileCleaner = makeMockProfileCleaner();
    const keychain = new MemoryKeychain();

    const result = await performLogout(bridgeClient, sessionManager, profileCleaner, keychain);

    expect(result.bridgeDisconnected).toBe(true);
    expect(result.browserProfilesCleared).toBe(1);
    expect(result.identityCleared).toBe(true);
    expect(result.ok).toBe(true);
    expect(
      (bridgeClient as unknown as { disconnect: ReturnType<typeof vi.fn> }).disconnect,
    ).toHaveBeenCalledTimes(1);
    expect(profileCleaner.clearStorageData).toHaveBeenCalledWith("persist:snowharness-browser-u1");
    expect(sessionManager.removeBrowserProfile).toHaveBeenCalledWith("u1");
  });

  it("BridgeClient 为 null 时跳过断开步骤", async () => {
    const sessionManager = makeMockSessionManager([]);
    const profileCleaner = makeMockProfileCleaner();
    const keychain = new MemoryKeychain();

    const result = await performLogout(null, sessionManager, profileCleaner, keychain);

    expect(result.bridgeDisconnected).toBe(true);
    expect(result.browserProfilesCleared).toBe(0);
    expect(result.identityCleared).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("BridgeClient.disconnect 抛错时 bridgeDisconnected=false 但后续步骤仍执行", async () => {
    const bridgeClient = makeMockBridgeClient(true);
    const sessionManager = makeMockSessionManager(["u1"]);
    const profileCleaner = makeMockProfileCleaner();
    const keychain = new MemoryKeychain();

    const result = await performLogout(bridgeClient, sessionManager, profileCleaner, keychain);

    expect(result.bridgeDisconnected).toBe(false);
    expect(result.browserProfilesCleared).toBe(1);
    expect(result.identityCleared).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("Profile 清理失败不阻断后续清理", async () => {
    const bridgeClient = makeMockBridgeClient();
    const sessionManager = makeMockSessionManager(["u1"]);
    const profileCleaner = makeMockProfileCleaner(true);
    const keychain = new MemoryKeychain();

    const result = await performLogout(bridgeClient, sessionManager, profileCleaner, keychain);

    expect(result.bridgeDisconnected).toBe(true);
    expect(result.browserProfilesCleared).toBe(0);
    expect(result.identityCleared).toBe(true);
    // ok=false 因 bridgeDisconnected=true 但 browserProfilesCleared=0（不影响 ok，ok 只看 bridge+identity）
    expect(result.ok).toBe(true);
  });

  it("Keychain 清理失败时 identityCleared=false", async () => {
    const bridgeClient = makeMockBridgeClient();
    const sessionManager = makeMockSessionManager([]);
    const profileCleaner = makeMockProfileCleaner();
    const failingKeychain: KeychainAdapter = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockRejectedValue(new Error("keychain error")),
      isAvailable: vi.fn(() => true),
    };

    const result = await performLogout(
      bridgeClient,
      sessionManager,
      profileCleaner,
      failingKeychain,
    );

    expect(result.bridgeDisconnected).toBe(true);
    expect(result.identityCleared).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("多个 userId 全部清理", async () => {
    const bridgeClient = makeMockBridgeClient();
    const sessionManager = makeMockSessionManager(["u1", "u2", "u3"]);
    const profileCleaner = makeMockProfileCleaner();
    const keychain = new MemoryKeychain();

    const result = await performLogout(bridgeClient, sessionManager, profileCleaner, keychain);

    expect(result.browserProfilesCleared).toBe(3);
    expect(profileCleaner.clearStorageData).toHaveBeenCalledTimes(3);
    expect(sessionManager.removeBrowserProfile).toHaveBeenCalledTimes(3);
  });

  it("无 userId 时 browserProfilesCleared=0", async () => {
    const bridgeClient = makeMockBridgeClient();
    const sessionManager = makeMockSessionManager([]);
    const profileCleaner = makeMockProfileCleaner();
    const keychain = new MemoryKeychain();

    const result = await performLogout(bridgeClient, sessionManager, profileCleaner, keychain);

    expect(result.browserProfilesCleared).toBe(0);
    expect(profileCleaner.clearStorageData).not.toHaveBeenCalled();
  });
});
