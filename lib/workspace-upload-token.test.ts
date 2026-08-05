import {
  type ConsumedToken,
  type UploadTokenStore,
  UploadTokenStore as UploadTokenStoreClass,
  consumeUploadToken,
  issueUploadToken,
} from "@/lib/workspace-upload-token";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V10 Phase 7-2：Workspace 上传一次性下载凭证测试。
 *
 * 验证 UploadTokenStore 与全局单例：
 * - issue 创建凭证，返回非空 token
 * - consume 消费有效凭证，返回 { threadId, workspacePath }
 * - consume 同一 token 第二次返回 null（一次性使用）
 * - consume 无效 token 返回 null
 * - consume 过期 token 返回 null（使用 fakeTimers）
 * - cleanup 清理过期凭证
 * - size 返回当前凭证数量
 * - 不同 threadId/workspacePath 的凭证独立
 *
 * 全局单例 issueUploadToken / consumeUploadToken 复用同一 store，
 * 每个测试 beforeEach 重置（通过手动 cleanup + 重新创建实例）。
 */

describe("UploadTokenStore - 单元测试", () => {
  let store: UploadTokenStore;

  beforeEach(() => {
    store = new UploadTokenStoreClass(60_000);
  });

  it("issue 创建凭证返回非空 token", () => {
    const token = store.issue("thread-1", "uploads/image.png");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(store.size()).toBe(1);
  });

  it("consume 消费有效凭证返回 { threadId, workspacePath }", () => {
    const token = store.issue("thread-1", "uploads/image.png");
    const consumed = store.consume(token);
    expect(consumed).not.toBeNull();
    expect(consumed).toEqual({ threadId: "thread-1", workspacePath: "uploads/image.png" });
  });

  it("consume 同一 token 第二次返回 null（一次性使用）", () => {
    const token = store.issue("thread-1", "uploads/image.png");
    const first = store.consume(token);
    expect(first).not.toBeNull();
    const second = store.consume(token);
    expect(second).toBeNull();
  });

  it("consume 无效 token 返回 null", () => {
    expect(store.consume("nonexistent-token")).toBeNull();
    expect(store.consume("")).toBeNull();
  });

  it("consume 过期 token 返回 null", () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const shortTtlStore = new UploadTokenStoreClass(1_000); // 1s TTL
    const token = shortTtlStore.issue("thread-1", "uploads/image.png");
    // 推进时间超过 TTL
    vi.setSystemTime(now + 2_000);
    const consumed = shortTtlStore.consume(token);
    expect(consumed).toBeNull();
    vi.useRealTimers();
  });

  it("cleanup 清理过期凭证并返回清理数量", () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);
    const shortTtlStore = new UploadTokenStoreClass(1_000);
    shortTtlStore.issue("thread-1", "uploads/a.png");
    shortTtlStore.issue("thread-2", "uploads/b.png");
    expect(shortTtlStore.size()).toBe(2);
    // 推进时间使两个凭证都过期
    vi.setSystemTime(base + 2_000);
    const cleaned = shortTtlStore.cleanup(Date.now());
    expect(cleaned).toBe(2);
    expect(shortTtlStore.size()).toBe(0);
    vi.useRealTimers();
  });

  it("cleanup 不清理未过期凭证", () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);
    const store2 = new UploadTokenStoreClass(60_000);
    store2.issue("thread-1", "uploads/a.png");
    vi.setSystemTime(base + 1_000);
    const cleaned = store2.cleanup(Date.now());
    expect(cleaned).toBe(0);
    expect(store2.size()).toBe(1);
    vi.useRealTimers();
  });

  it("size 返回当前凭证数量", () => {
    expect(store.size()).toBe(0);
    store.issue("thread-1", "uploads/a.png");
    expect(store.size()).toBe(1);
    store.issue("thread-2", "uploads/b.png");
    expect(store.size()).toBe(2);
  });

  it("不同 threadId/workspacePath 的凭证独立", () => {
    const tokenA = store.issue("thread-a", "uploads/a.png");
    const tokenB = store.issue("thread-b", "uploads/b.png");
    expect(tokenA).not.toBe(tokenB);
    const consumedA = store.consume(tokenA) as ConsumedToken;
    const consumedB = store.consume(tokenB) as ConsumedToken;
    expect(consumedA.threadId).toBe("thread-a");
    expect(consumedA.workspacePath).toBe("uploads/a.png");
    expect(consumedB.threadId).toBe("thread-b");
    expect(consumedB.workspacePath).toBe("uploads/b.png");
  });

  it("issue 多次生成不同 token（UUID 唯一性）", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(store.issue("thread-1", "uploads/x.png"));
    }
    expect(tokens.size).toBe(100);
  });
});

describe("全局单例 issueUploadToken / consumeUploadToken", () => {
  // 全局单例无法重置，每个测试用不同的 token 值避免相互影响
  // 使用唯一 threadId 避免污染其他测试

  it("issueUploadToken 返回非空 token", () => {
    const token = issueUploadToken("global-thread-1", "uploads/x.png");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("consumeUploadToken 消费全局签发的凭证", () => {
    const token = issueUploadToken("global-thread-2", "uploads/y.png");
    const consumed = consumeUploadToken(token);
    expect(consumed).toEqual({
      threadId: "global-thread-2",
      workspacePath: "uploads/y.png",
    });
  });

  it("consumeUploadToken 一次性使用（第二次返回 null）", () => {
    const token = issueUploadToken("global-thread-3", "uploads/z.png");
    const first = consumeUploadToken(token);
    expect(first).not.toBeNull();
    const second = consumeUploadToken(token);
    expect(second).toBeNull();
  });

  it("consumeUploadToken 无效 token 返回 null", () => {
    expect(consumeUploadToken("invalid-token-xyz")).toBeNull();
  });
});
