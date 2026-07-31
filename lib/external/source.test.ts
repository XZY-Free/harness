import { describe, expect, it } from "vitest";
import { buildExternalSource, computeContentHash, matchDomain } from "./source";

/**
 * V3.4 Stage B：外部来源记录纯函数测试。
 */

describe("computeContentHash", () => {
  it("sha256 稳定：相同内容相同 hash", () => {
    expect(computeContentHash("hello")).toBe(computeContentHash("hello"));
    expect(computeContentHash("hello")).not.toBe(computeContentHash("world"));
  });

  it("返回 64 位 hex", () => {
    expect(computeContentHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("matchDomain", () => {
  it("精确匹配 + 子域匹配，大小写不敏感", () => {
    expect(matchDomain("example.com", "example.com")).toBe(true);
    expect(matchDomain("docs.example.com", "example.com")).toBe(true);
    expect(matchDomain("EXAMPLE.COM", "example.com")).toBe(true);
    expect(matchDomain("notexample.com", "example.com")).toBe(false);
    expect(matchDomain("evil.com", "example.com")).toBe(false);
  });

  it("条目前导点容忍", () => {
    expect(matchDomain("a.example.com", ".example.com")).toBe(true);
  });

  it("空条目不匹配", () => {
    expect(matchDomain("example.com", "")).toBe(false);
  });
});

describe("buildExternalSource", () => {
  it("默认 24h 过期 + contentHash + fetchedAt ISO", () => {
    const fetchedAt = new Date("2026-06-23T00:00:00Z");
    const s = buildExternalSource({
      sourceUrl: "https://example.com/page",
      content: "hello",
      fetchedAt,
    });
    expect(s.sourceUrl).toBe("https://example.com/page");
    expect(s.contentHash).toBe(computeContentHash("hello"));
    expect(s.fetchedAt).toBe("2026-06-23T00:00:00.000Z");
    // 24h 后
    expect(new Date(s.expiresAt ?? "").getTime() - fetchedAt.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("dynamic=true → 1h 过期", () => {
    const fetchedAt = new Date("2026-06-23T00:00:00Z");
    const s = buildExternalSource({ sourceUrl: "u", content: "c", fetchedAt, dynamic: true });
    expect(new Date(s.expiresAt ?? "").getTime() - fetchedAt.getTime()).toBe(60 * 60 * 1000);
  });

  it("artifactPath 透传", () => {
    const s = buildExternalSource({
      sourceUrl: "u",
      content: "c",
      artifactPath: ".snow/runtime/tid/external/x.txt",
    });
    expect(s.artifactPath).toBe(".snow/runtime/tid/external/x.txt");
  });
});
