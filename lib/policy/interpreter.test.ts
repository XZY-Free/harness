import { defaultPolicyConfig } from "@/lib/policy/config";
import { interpretPolicyConfig } from "@/lib/policy/interpreter";
import { describe, expect, it } from "vitest";

/**
 * Phase 4-4 Stage E：policy 解释器单测。
 * 覆盖完整行 → 等价 PolicyConfig；缺键 → 回退默认；非法正则 → 回退默认（fail-soft 不抛）。
 */

const DEFAULT_ROWS = [
  { key: "protectedPaths", value: ["^\\.git(\\/|$)"] },
  {
    key: "commandDenyList",
    value: [
      "\\brm\\s+-[a-z]*r[a-z]*f?\\s+(\\/|~)",
      ":\\s*\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:&\\s*\\}\\s*;\\s*:",
      "\\bmkfs\\.\\w+\\b",
      "\\bdd\\b[^|]*\\bof=\\/dev\\/",
    ],
  },
  { key: "formatOnWrite", value: { enabled: true, command: "prettier --write" } },
  {
    key: "verifyBeforeDelivery",
    value: {
      enabled: true,
      command: "npm test",
      timeoutMs: 60000,
      timeoutIsFailure: false,
      testFilePattern: "(^|\\/)(__tests__|tests?|spec)\\/|\\.(test|spec)\\.[cm]?[jt]sx?$",
    },
  },
];

describe("interpretPolicyConfig (Stage E)", () => {
  it("完整行 → 等价 PolicyConfig（正则行为一致）", () => {
    const cfg = interpretPolicyConfig(DEFAULT_ROWS);
    // protectedPaths：.git 拒、src 放行
    expect(cfg.protectedPaths).toHaveLength(1);
    expect(cfg.protectedPaths[0]?.test(".git/config")).toBe(true);
    expect(cfg.protectedPaths[0]?.test("src/a.js")).toBe(false);

    // commandDenyList：rm -rf / 拒、npm install 放行
    expect(cfg.commandDenyList).toHaveLength(4);
    expect(cfg.commandDenyList[0]?.test("rm -rf /")).toBe(true);
    expect(cfg.commandDenyList.some((re) => re.test("npm install"))).toBe(false);

    // formatOnWrite
    expect(cfg.formatOnWrite).toEqual({ enabled: true, command: "prettier --write" });

    // verifyBeforeDelivery：detect 重建——app.test.js 命中、index.html 不命中
    expect(cfg.verifyBeforeDelivery.enabled).toBe(true);
    expect(cfg.verifyBeforeDelivery.detect(["app.test.js"])).toBe(true);
    expect(cfg.verifyBeforeDelivery.detect(["index.html"])).toBe(false);
    expect(cfg.verifyBeforeDelivery.timeoutMs).toBe(60000);
  });

  it("缺键 → 逐字段回退默认", () => {
    const cfg = interpretPolicyConfig([
      { key: "formatOnWrite", value: { enabled: false, command: "" } },
    ]);
    // 命中的字段用 DB 值
    expect(cfg.formatOnWrite.enabled).toBe(false);
    // 缺失的字段回退默认
    expect(cfg.protectedPaths).toEqual(defaultPolicyConfig.protectedPaths);
    expect(cfg.commandDenyList).toEqual(defaultPolicyConfig.commandDenyList);
    expect(cfg.verifyBeforeDelivery.enabled).toBe(defaultPolicyConfig.verifyBeforeDelivery.enabled);
    // 默认 detect 仍可工作
    expect(cfg.verifyBeforeDelivery.detect(["app.test.js"])).toBe(true);
  });

  it("非法正则源 → 整字段回退默认（fail-soft 不抛）", () => {
    const cfg = interpretPolicyConfig([
      { key: "protectedPaths", value: ["[invalid("] },
      { key: "commandDenyList", value: ["(unclosed"] },
    ]);
    expect(cfg.protectedPaths).toEqual(defaultPolicyConfig.protectedPaths);
    expect(cfg.commandDenyList).toEqual(defaultPolicyConfig.commandDenyList);
  });

  it("value 形状不符 → 回退默认（formatOnWrite / verifyBeforeDelivery）", () => {
    const cfg = interpretPolicyConfig([
      { key: "formatOnWrite", value: "not-an-object" },
      { key: "verifyBeforeDelivery", value: null },
    ]);
    expect(cfg.formatOnWrite).toEqual(defaultPolicyConfig.formatOnWrite);
    expect(cfg.verifyBeforeDelivery).toEqual(defaultPolicyConfig.verifyBeforeDelivery);
  });

  it("testFilePattern 非法 → 回退默认 pattern（detect 仍可用）", () => {
    const cfg = interpretPolicyConfig([
      {
        key: "verifyBeforeDelivery",
        value: {
          enabled: true,
          command: "npm test",
          timeoutMs: 60000,
          timeoutIsFailure: false,
          testFilePattern: "[bad(",
        },
      },
    ]);
    expect(cfg.verifyBeforeDelivery.detect(["app.test.js"])).toBe(true);
    expect(cfg.verifyBeforeDelivery.detect(["index.html"])).toBe(false);
  });

  it("空行集 → 全默认", () => {
    const cfg = interpretPolicyConfig([]);
    expect(cfg.protectedPaths).toEqual(defaultPolicyConfig.protectedPaths);
    expect(cfg.verifyBeforeDelivery.detect(["a.spec.ts"])).toBe(true);
  });
});
