import {
  BrandValidationError,
  DEFAULT_BRAND,
  applyBrandPatch,
  parseBrandPatch,
  validateBrandAssetPath,
} from "@/lib/branding/brand-contract";
import { describe, expect, it } from "vitest";

describe("validateBrandAssetPath", () => {
  it("接受根相对的 svg/png/webp/jpeg 路径", () => {
    expect(validateBrandAssetPath("/brand/mark.svg", "icon")).toBe("/brand/mark.svg");
    expect(validateBrandAssetPath("/brand/mark.png", "icon")).toBe("/brand/mark.png");
    expect(validateBrandAssetPath(" /brand/mark.webp ", "icon")).toBe("/brand/mark.webp");
  });

  it("拒绝协议、双斜杠、反斜杠、穿越与 data URI", () => {
    for (const bad of [
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "/brand/..//secret.png",
      "/brand\\x.png",
      "data:image/png;base64,AAAA",
      "/brand/mark.gif",
    ]) {
      expect(() => validateBrandAssetPath(bad, "icon")).toThrow(BrandValidationError);
    }
  });
});

describe("applyBrandPatch", () => {
  it("部分 patch 只改声明字段，logo 可单侧覆盖", () => {
    const next = applyBrandPatch(DEFAULT_BRAND, {
      name: " Acme Cloud ",
      logo: { dark: "/brand/dark.svg" },
    });
    expect(next.name).toBe("Acme Cloud");
    expect(next.logo.light).toBe(DEFAULT_BRAND.logo.light);
    expect(next.logo.dark).toBe("/brand/dark.svg");
    expect(next.tagline).toBe(DEFAULT_BRAND.tagline);
    expect(next.packaging).toEqual(DEFAULT_BRAND.packaging);
  });

  it("name 超长或空拒绝", () => {
    expect(() => applyBrandPatch(DEFAULT_BRAND, { name: "" })).toThrow(BrandValidationError);
    expect(() => applyBrandPatch(DEFAULT_BRAND, { name: "x".repeat(41) })).toThrow(
      BrandValidationError,
    );
  });
});

describe("parseBrandPatch", () => {
  it("只提取合同字段，忽略 revision 等服务端字段", () => {
    const patch = parseBrandPatch({
      name: "Acme",
      revision: 99,
      updatedAt: "2026-09-11T00:00:00Z",
      icon: "/brand/i.png",
      unknown: 1,
    });
    expect(patch).toEqual({ name: "Acme", icon: "/brand/i.png" });
  });
});
