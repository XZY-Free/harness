import { db } from "@/lib/db/client";
import { policyConfig } from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Phase 4-4 Stage E：policy config DB 读取 + override/cached 优先级单测。
 *
 * loadPolicyConfigFromDB 读真实 MySQL policyConfig 表（生产同构）。
 * getPolicyConfig 覆盖 override 优先、reset 清除。
 * refreshPolicyConfigFromDB 在 test 态 no-op（不读 DB，零回归）。
 */

import {
  defaultPolicyConfig,
  defaultPolicyRows,
  getPolicyConfig,
  loadPolicyConfigFromDB,
  refreshPolicyConfigFromDB,
  resetPolicyConfig,
  setPolicyConfig,
} from "@/lib/policy/config";
import { interpretPolicyConfig } from "@/lib/policy/interpreter";

beforeEach(async () => {
  await resetDatabase(db);
  resetPolicyConfig();
});

describe("getPolicyConfig override / cached (Stage E)", () => {
  it("默认返回 defaultPolicyConfig（cached）", () => {
    expect(getPolicyConfig()).toBe(defaultPolicyConfig);
  });

  it("setPolicyConfig 注入 → override 优先", () => {
    const custom = { ...defaultPolicyConfig, protectedPaths: [/^secrets\//] };
    setPolicyConfig(custom);
    expect(getPolicyConfig()).toBe(custom);
    expect(getPolicyConfig().protectedPaths[0]?.test("secrets/x")).toBe(true);
  });

  it("resetPolicyConfig 清除 override → 回 cached", () => {
    setPolicyConfig({ ...defaultPolicyConfig, protectedPaths: [/^x\//] });
    resetPolicyConfig();
    expect(getPolicyConfig()).toBe(defaultPolicyConfig);
  });
});

describe("loadPolicyConfigFromDB (真实 MySQL)", () => {
  it("DB 命中 → 解释为 PolicyConfig", async () => {
    const now = new Date();
    await db.insert(policyConfig).values([
      { key: "protectedPaths", value: ["^\\.git(\\/|$)"], updatedAt: now },
      { key: "commandDenyList", value: ["\\brm\\s+-[a-z]*r[a-z]*f?\\s+(\\/|~)"], updatedAt: now },
      { key: "formatOnWrite", value: { enabled: false, command: "" }, updatedAt: now },
      {
        key: "verifyBeforeDelivery",
        value: {
          enabled: true,
          command: "npm test",
          timeoutMs: 60000,
          timeoutIsFailure: false,
          testFilePattern: "(^|\\/)(__tests__|tests?|spec)\\/|\\.(test|spec)\\.[cm]?[jt]sx?$",
        },
        updatedAt: now,
      },
    ]);

    const cfg = await loadPolicyConfigFromDB();
    expect(cfg.formatOnWrite.enabled).toBe(false);
    expect(cfg.protectedPaths[0]?.test(".git/config")).toBe(true);
    expect(cfg.verifyBeforeDelivery.detect(["app.test.js"])).toBe(true);
  });

  it("DB 空 → defaultPolicyConfig", async () => {
    const cfg = await loadPolicyConfigFromDB();
    expect(cfg).toBe(defaultPolicyConfig);
  });
});

describe("refreshPolicyConfigFromDB (Stage E)", () => {
  it("test 态 no-op：不读 DB（零回归）", async () => {
    await refreshPolicyConfigFromDB();
    expect(getPolicyConfig()).toBe(defaultPolicyConfig);
  });
});

describe("defaultPolicyRows round-trip (Stage E)", () => {
  it("interpretPolicyConfig(defaultPolicyRows()) ≡ defaultPolicyConfig", () => {
    const rows = defaultPolicyRows();
    const cfg = interpretPolicyConfig(rows);
    expect(cfg.protectedPaths.map((r) => r.source)).toEqual(
      defaultPolicyConfig.protectedPaths.map((r) => r.source),
    );
    expect(cfg.commandDenyList.map((r) => r.source)).toEqual(
      defaultPolicyConfig.commandDenyList.map((r) => r.source),
    );
    expect(cfg.formatOnWrite).toEqual(defaultPolicyConfig.formatOnWrite);
    expect(cfg.verifyBeforeDelivery.detect(["app.test.js"])).toBe(
      defaultPolicyConfig.verifyBeforeDelivery.detect(["app.test.js"]),
    );
    expect(cfg.verifyBeforeDelivery.detect(["index.html"])).toBe(false);
    expect(cfg.verifyBeforeDelivery.timeoutMs).toBe(
      defaultPolicyConfig.verifyBeforeDelivery.timeoutMs,
    );
  });
});
