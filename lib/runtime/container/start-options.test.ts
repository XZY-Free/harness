import { afterEach, describe, expect, it } from "vitest";
import {
  __clearSecretFileCacheForTest,
  cleanupSecretFileCache,
  prepareContainerStartOptions,
} from "./start-options";

/**
 * S1 修复（02-P1-9）：container secret env 文件缓存测试。
 * 同 threadId + 同 secrets → 复用文件路径（缓存命中，跳过重写）。
 */

const TID = "t-cache";

afterEach(async () => {
  await cleanupSecretFileCache(TID).catch(() => {});
  __clearSecretFileCacheForTest();
});

describe("prepareContainerStartOptions secret env 文件缓存", () => {
  it("同 secrets 连续两次调用 → 复用同一文件路径（缓存命中）", async () => {
    const secrets = { API_KEY: "sk-1234567890abcdef", DB_URL: "mysql://x" };
    const a = await prepareContainerStartOptions({
      threadId: TID,
      existingSecrets: secrets,
    });
    const b = await prepareContainerStartOptions({
      threadId: TID,
      existingSecrets: secrets,
    });
    expect(a.startOptions.secretEnvFile).toBeTruthy();
    expect(b.startOptions.secretEnvFile).toBe(a.startOptions.secretEnvFile); // 缓存命中：同路径
  });

  it("secrets 变化 → 重写新文件（缓存未命中，路径可能变）", async () => {
    const a = await prepareContainerStartOptions({
      threadId: TID,
      existingSecrets: { API_KEY: "sk-1111111111111111" },
    });
    const b = await prepareContainerStartOptions({
      threadId: TID,
      existingSecrets: { API_KEY: "sk-2222222222222222" }, // 不同 secret
    });
    expect(a.startOptions.secretEnvFile).toBeTruthy();
    expect(b.startOptions.secretEnvFile).toBeTruthy();
    // hash 不同 → 重写；路径可能相同（覆盖）或不同，但 secretsCache 已更新
    expect(b.secretsCache?.API_KEY).toBe("sk-2222222222222222");
  });

  it("无 secrets → 无 secretEnvFile", async () => {
    const a = await prepareContainerStartOptions({ threadId: TID });
    expect(a.startOptions.secretEnvFile).toBeUndefined();
  });

  it("cleanup 是 no-op（不删除缓存文件，跨 exec 复用）", async () => {
    const a = await prepareContainerStartOptions({
      threadId: TID,
      existingSecrets: { API_KEY: "sk-9999999999999999" },
    });
    await a.cleanup(); // no-op，文件仍在
    const b = await prepareContainerStartOptions({
      threadId: TID,
      existingSecrets: { API_KEY: "sk-9999999999999999" },
    });
    expect(b.startOptions.secretEnvFile).toBe(a.startOptions.secretEnvFile); // 文件仍存在，复用
  });
});
