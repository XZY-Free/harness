import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
/**
 * V10 Phase 3：Keychain adapter，包装 Electron safeStorage。
 *
 * 使用 macOS Keychain（通过 Electron safeStorage）加密字符串，
 * 加密后的数据写入 app.getPath('userData')/keychain/<key>.enc 文件。
 *
 * 安全约束：
 * - safeStorage 不可用时 set 抛出 KEYCHAIN_ERROR。
 * - 解密失败时 get 抛出 KEYCHAIN_ERROR。
 * - key 文件不存在时 get 返回 null（视为未存储）。
 * - delete 不存在的 key 静默成功（幂等）。
 */
import { app, safeStorage } from "electron";
import { DesktopErrorCode, desktopError } from "../../lib/desktop/errors";

/** Keychain adapter 接口，便于测试 mock。 */
export interface KeychainAdapter {
  /** 安全存储字符串（加密后写入文件） */
  set(key: string, value: string): Promise<void>;
  /** 读取并解密 */
  get(key: string): Promise<string | null>;
  /** 删除 */
  delete(key: string): Promise<void>;
  /** 检查 safeStorage 是否可用（macOS Keychain 可访问） */
  isAvailable(): boolean;
}

/** 判断错误是否为 ENOENT（文件不存在）。 */
function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

/** 获取 keychain 存储目录。 */
function getKeychainDir(): string {
  return join(app.getPath("userData"), "keychain");
}

/** 获取 key 对应的加密文件路径。 */
function getFilePath(key: string): string {
  return join(getKeychainDir(), `${key}.enc`);
}

/**
 * 基于 Electron safeStorage 的 Keychain 实现。
 *
 * 加密后的数据以 .enc 文件形式存储在 userData/keychain/ 目录下。
 */
export class ElectronKeychain implements KeychainAdapter {
  async set(key: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw desktopError(
        DesktopErrorCode.KEYCHAIN_ERROR,
        "safeStorage 不可用（macOS Keychain 无法访问）",
      );
    }
    const encrypted = safeStorage.encryptString(value);
    const filepath = getFilePath(key);
    await mkdir(getKeychainDir(), { recursive: true });
    await writeFile(filepath, encrypted);
  }

  async get(key: string): Promise<string | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(getFilePath(key));
    } catch (err) {
      if (isENOENT(err)) {
        return null;
      }
      throw desktopError(DesktopErrorCode.KEYCHAIN_ERROR, `读取 keychain 失败: ${key}`, {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      return safeStorage.decryptString(encrypted);
    } catch (err) {
      throw desktopError(DesktopErrorCode.KEYCHAIN_ERROR, `解密失败: ${key}`, {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(getFilePath(key));
    } catch (err) {
      if (isENOENT(err)) {
        return;
      }
      throw desktopError(DesktopErrorCode.KEYCHAIN_ERROR, `删除 keychain 失败: ${key}`, {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }
}

/** 默认 keychain 实例。 */
export const keychain: KeychainAdapter = new ElectronKeychain();
