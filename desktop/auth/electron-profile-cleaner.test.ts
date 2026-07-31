import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V10 Phase 8：ElectronProfileCleaner 单元测试。
 *
 * mock electron 的 session 模块，验证：
 * - clearStorageData 调用 session.fromPartition 获取 session 并调用 clearStorageData
 * - 传入正确的 partition 名称
 * - clearStorageData 抛错时向上传播
 */

const { sessionMock, clearStorageDataMock, fromPartitionMock } = vi.hoisted(() => {
  const clearStorageDataMock = vi.fn<(options?: unknown) => Promise<void>>();
  const fakeSession = { clearStorageData: clearStorageDataMock };
  const fromPartitionMock = vi.fn((partition: string) => {
    // 返回带 partition 标记的 fake session，便于断言调用参数
    return { ...fakeSession, __partition: partition };
  });
  const sessionMock = {
    fromPartition: fromPartitionMock,
    defaultSession: { clearStorageData: clearStorageDataMock },
  };
  return { sessionMock, clearStorageDataMock, fromPartitionMock };
});

vi.mock("electron", () => ({ session: sessionMock }));

import { ElectronProfileCleaner } from "./electron-profile-cleaner";

describe("ElectronProfileCleaner (V10 Phase 8)", () => {
  let cleaner: ElectronProfileCleaner;

  beforeEach(() => {
    cleaner = new ElectronProfileCleaner();
    fromPartitionMock.mockClear();
    clearStorageDataMock.mockClear();
    clearStorageDataMock.mockResolvedValue(undefined);
  });

  it("调用 session.fromPartition 获取 session 并调用 clearStorageData", async () => {
    await cleaner.clearStorageData("persist:snowharness-browser-alice");

    expect(fromPartitionMock).toHaveBeenCalledWith("persist:snowharness-browser-alice");
    expect(clearStorageDataMock).toHaveBeenCalledTimes(1);
  });

  it("不同 partition 传入不同参数", async () => {
    await cleaner.clearStorageData("persist:snowharness-browser-alice");
    await cleaner.clearStorageData("persist:snowharness-browser-bob");

    expect(fromPartitionMock).toHaveBeenNthCalledWith(1, "persist:snowharness-browser-alice");
    expect(fromPartitionMock).toHaveBeenNthCalledWith(2, "persist:snowharness-browser-bob");
    expect(clearStorageDataMock).toHaveBeenCalledTimes(2);
  });

  it("clearStorageData 无参数调用（清理所有存储类型）", async () => {
    await cleaner.clearStorageData("persist:snowharness-browser-alice");

    expect(clearStorageDataMock).toHaveBeenCalledWith();
  });

  it("clearStorageData 抛错时向上传播", async () => {
    const error = new Error("清理失败");
    clearStorageDataMock.mockRejectedValue(error);

    await expect(cleaner.clearStorageData("persist:snowharness-browser-alice")).rejects.toThrow(
      "清理失败",
    );
  });

  it("incognito partition 也可清理", async () => {
    await cleaner.clearStorageData("snowharness-incognito-thread-1-nonce");

    expect(fromPartitionMock).toHaveBeenCalledWith("snowharness-incognito-thread-1-nonce");
    expect(clearStorageDataMock).toHaveBeenCalledTimes(1);
  });
});
