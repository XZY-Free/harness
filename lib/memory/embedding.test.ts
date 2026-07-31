import { describe, expect, it } from "vitest";
import {
  DeterministicFakeEmbeddingProvider,
  DisabledEmbeddingProvider,
  ErrorEmbeddingProvider,
  cosineSimilarity,
} from "./embedding";

describe("cosineSimilarity", () => {
  it("相同向量 → 1", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it("正交 → 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("维度不一致 → 0（防御）", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
  it("空向量 → 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("DeterministicFakeEmbeddingProvider（不请求真实网络）", () => {
  it("同一文本 → 同一向量（确定性）", async () => {
    const p = new DeterministicFakeEmbeddingProvider();
    const a = await p.embed("commit 用 Lore");
    const b = await p.embed("commit 用 Lore");
    expect(a.vector).toEqual(b.vector);
    expect(a.status).toBe("ready");
    expect(a.dim).toBe(16);
  });
  it("不同文本 → 不同向量", async () => {
    const p = new DeterministicFakeEmbeddingProvider();
    expect((await p.embed("foo")).vector).not.toEqual((await p.embed("bar")).vector);
  });
  it("isReady=true", () => {
    expect(new DeterministicFakeEmbeddingProvider().isReady()).toBe(true);
  });
});

describe("Disabled / Error provider 不静默伪装成功", () => {
  it("Disabled: isReady=false, embed status=disabled", async () => {
    const p = new DisabledEmbeddingProvider();
    expect(p.isReady()).toBe(false);
    const r = await p.embed("x");
    expect(r.status).toBe("disabled");
    expect(r.vector).toEqual([]);
  });
  it("Error: embed status=error（不抛、不伪装 ready）", async () => {
    const p = new ErrorEmbeddingProvider();
    const r = await p.embed("x");
    expect(r.status).toBe("error");
    expect(r.error).toBeTruthy();
  });
});
