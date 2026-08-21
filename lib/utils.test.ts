import { escapeLikeWildcards, generateUUID } from "@/lib/utils";
import { describe, expect, it } from "vitest";

describe("generateUUID", () => {
  it("应生成合法 v4 UUID", () => {
    const id = generateUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("两次调用不重复", () => {
    expect(generateUUID()).not.toBe(generateUUID());
  });
});

describe("escapeLikeWildcards (P2-2)", () => {
  it("转义 % _ \\", () => {
    expect(escapeLikeWildcards("100%_done")).toBe("100\\%\\_done");
    expect(escapeLikeWildcards("a\\b")).toBe("a\\\\b");
  });
  it("普通文本不变", () => {
    expect(escapeLikeWildcards("hello")).toBe("hello");
  });
});
