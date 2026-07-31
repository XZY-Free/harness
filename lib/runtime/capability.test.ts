import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCapability, isHostHonestlyMarked } from "./capability";
import type { ResourceQuota } from "./types";

/**
 * V3.8 Stage A：RuntimeCapability 上报测试。
 *
 * 覆盖：
 * - capability 字段完整性（runtimeType/imageVersion/networkPolicy/quotas/enforced flags/secretMount/available）。
 * - host 模式诚实标注：networkPolicy=open / networkPolicyEnforced=false / quotaEnforced=false。
 * - container 模式：networkPolicyEnforced=true / quotaEnforced=true。
 */

const origEnv = { ...process.env };

beforeEach(() => {
  process.env.RUNTIME_NETWORK_POLICY = "open";
  process.env.RUNTIME_QUOTA_CPU = "1.0";
  process.env.RUNTIME_QUOTA_MEMORY = "1g";
  process.env.RUNTIME_QUOTA_TIMEOUT_MS = "60000";
  process.env.RUNTIME_QUOTA_LOG_CAP_BYTES = String(1024 * 1024);
});

afterEach(() => {
  for (const k of [
    "RUNTIME_NETWORK_POLICY",
    "RUNTIME_QUOTA_CPU",
    "RUNTIME_QUOTA_MEMORY",
    "RUNTIME_QUOTA_TIMEOUT_MS",
    "RUNTIME_QUOTA_LOG_CAP_BYTES",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, origEnv);
});

describe("buildCapability", () => {
  it("host 模式：所有字段完整 + 诚实标注", () => {
    const cap = buildCapability({ runtimeType: "host" });
    expect(cap.runtimeType).toBe("host");
    expect(cap.imageVersion).toBeUndefined();
    expect(cap.networkPolicy).toBe("open");
    expect(cap.networkPolicyEnforced).toBe(false);
    expect(cap.quotaEnforced).toBe(false);
    expect(cap.secretMount).toBe(false);
    expect(cap.available).toBe(true);
    // quotas 非空
    expect(cap.quotas.cpu).toBeDefined();
    expect(cap.quotas.memory).toBeDefined();
    expect(cap.quotas.timeoutMs).toBeDefined();
    expect(cap.quotas.logCapBytes).toBeDefined();
  });

  it("container 模式：imageVersion + enforced=true", () => {
    process.env.SNOW_RUNTIME_IMAGE = "snow-harness-runtime:node22";
    const cap = buildCapability({
      runtimeType: "container",
      imageVersion: "snow-harness-runtime:node22",
    });
    expect(cap.runtimeType).toBe("container");
    expect(cap.imageVersion).toBe("snow-harness-runtime:node22");
    expect(cap.networkPolicyEnforced).toBe(true);
    expect(cap.quotaEnforced).toBe(true);
  });

  it("container 模式：networkPolicy 从全局配置解析", () => {
    process.env.RUNTIME_NETWORK_POLICY = "disabled";
    const cap = buildCapability({ runtimeType: "container" });
    expect(cap.networkPolicy).toBe("disabled");
    expect(cap.networkPolicyEnforced).toBe(true);
  });

  it("host 模式：networkPolicy 恒为 open（不管全局配置）", () => {
    process.env.RUNTIME_NETWORK_POLICY = "disabled";
    const cap = buildCapability({ runtimeType: "host" });
    // host 是信任平台，不可限制 egress → 恒 open
    expect(cap.networkPolicy).toBe("open");
    expect(cap.networkPolicyEnforced).toBe(false);
  });

  it("secretMount 默认 false（Stage C 启用前）", () => {
    expect(buildCapability({ runtimeType: "host" }).secretMount).toBe(false);
    expect(buildCapability({ runtimeType: "container" }).secretMount).toBe(false);
  });

  it("available=false 时正确标注", () => {
    const cap = buildCapability({ runtimeType: "container", available: false });
    expect(cap.available).toBe(false);
  });

  it("自定义 quota 透传", () => {
    const quota: ResourceQuota = {
      cpu: "0.5",
      memory: "256m",
      timeoutMs: 30_000,
      logCapBytes: 50_000,
    };
    const cap = buildCapability({ runtimeType: "container", quota });
    expect(cap.quotas).toEqual(quota);
  });
});

describe("isHostHonestlyMarked", () => {
  it("host capability 诚实标注 → true", () => {
    const cap = buildCapability({ runtimeType: "host" });
    expect(isHostHonestlyMarked(cap)).toBe(true);
  });

  it("container capability → true（非 host 不检查）", () => {
    const cap = buildCapability({ runtimeType: "container" });
    expect(isHostHonestlyMarked(cap)).toBe(true);
  });

  it("host 伪装 enforced=true → false", () => {
    const cap = buildCapability({ runtimeType: "host" });
    cap.networkPolicyEnforced = true;
    expect(isHostHonestlyMarked(cap)).toBe(false);
  });

  it("host 伪装 networkPolicy=disabled → false", () => {
    const cap = buildCapability({ runtimeType: "host" });
    cap.networkPolicy = "disabled";
    expect(isHostHonestlyMarked(cap)).toBe(false);
  });

  it("host 伪装 quotaEnforced=true → false", () => {
    const cap = buildCapability({ runtimeType: "host" });
    cap.quotaEnforced = true;
    expect(isHostHonestlyMarked(cap)).toBe(false);
  });
});
