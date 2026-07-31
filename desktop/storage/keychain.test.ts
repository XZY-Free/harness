import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V10 Phase 3：Keychain adapter 单元测试。
 *
 * mock electron 的 safeStorage 和 node:fs/promises，验证：
 * - set + get 往返正确
 * - get 未存储的 key 返回 null
 * - delete 后 get 返回 null
 * - isAvailable 返回 safeStorage.isEncryptionAvailable()
 * - safeStorage 不可用时 set 抛出 KEYCHAIN_ERROR
 * - 解密失败时 get 抛出 KEYCHAIN_ERROR
 */

// 使用 vi.hoisted 创建 mock，确保在模块导入前绑定
const { safeStorageMock, appMock, fsStore, fsMocks } = vi.hoisted(() => {
  // 内存文件系统，模拟 fs 读写
  const fsStore = new Map<string, unknown>();

  const safeStorageMock = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`ENC:${s}`)),
    decryptString: vi.fn((buf: Buffer) => {
      const str = buf.toString("utf8");
      if (!str.startsWith("ENC:")) {
        throw new Error("解密失败：无效的加密数据");
      }
      return str.slice(4);
    }),
  };

  const appMock = {
    getPath: vi.fn(() => "/mock/userdata"),
  };

  const fsMocks = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn((path: string, data: unknown) => {
      fsStore.set(path, data);
      return Promise.resolve();
    }),
    readFile: vi.fn((path: string) => {
      if (!fsStore.has(path)) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        return Promise.reject(err);
      }
      return Promise.resolve(fsStore.get(path));
    }),
    unlink: vi.fn((path: string) => {
      if (!fsStore.has(path)) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        return Promise.reject(err);
      }
      fsStore.delete(path);
      return Promise.resolve();
    }),
  };

  return { safeStorageMock, appMock, fsStore, fsMocks };
});

vi.mock("electron", () => ({
  safeStorage: safeStorageMock,
  app: appMock,
}));

vi.mock("node:fs/promises", () => fsMocks);

import { ElectronKeychain } from "./keychain";

describe("ElectronKeychain (V10 Phase 3)", () => {
  let kc: ElectronKeychain;

  beforeEach(() => {
    fsStore.clear();
    vi.clearAllMocks();
    // 重置默认行为
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation((s: string) => Buffer.from(`ENC:${s}`));
    safeStorageMock.decryptString.mockImplementation((buf: Buffer) => {
      const str = buf.toString("utf8");
      if (!str.startsWith("ENC:")) {
        throw new Error("解密失败：无效的加密数据");
      }
      return str.slice(4);
    });
    kc = new ElectronKeychain();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("set + get 往返正确", async () => {
    await kc.set("device-key", "secret-value-123");
    const value = await kc.get("device-key");

    expect(value).toBe("secret-value-123");
    // 验证加密/解密被调用
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith("secret-value-123");
    expect(safeStorageMock.decryptString).toHaveBeenCalled();
  });

  it("get 未存储的 key 返回 null", async () => {
    const value = await kc.get("not-exist");

    expect(value).toBeNull();
    // 未存储时不应调用 decryptString
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  it("delete 后 get 返回 null", async () => {
    await kc.set("temp-key", "temp-value");
    await kc.delete("temp-key");
    const value = await kc.get("temp-key");

    expect(value).toBeNull();
  });

  it("isAvailable 返回 safeStorage.isEncryptionAvailable()", () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(kc.isAvailable()).toBe(true);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(kc.isAvailable()).toBe(false);
  });

  it("safeStorage 不可用时 set 抛出 KEYCHAIN_ERROR", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    await expect(kc.set("key", "value")).rejects.toMatchObject({
      ok: false,
      code: "keychain_error",
    });
    // 不应调用 encryptString
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it("解密失败时 get 抛出 KEYCHAIN_ERROR", async () => {
    // 先正常写入
    await kc.set("bad-key", "some-value");
    // 让 decryptString 抛错
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error("decrypt failed");
    });

    await expect(kc.get("bad-key")).rejects.toMatchObject({
      ok: false,
      code: "keychain_error",
    });
  });
});
