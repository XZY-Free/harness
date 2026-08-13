import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dockerNetworkMode, resolveNetworkPolicy } from "./network-policy";

/**
 * V3.8 Stage B：网络策略测试。
 *
 * S1 修复（02-P0-2，方案 B）：删除 allowlist 模式后重写。覆盖：策略解析 / docker network 参数 / host 诚实标注。
 */

const origEnv = { ...process.env };

beforeEach(() => {
  process.env.RUNTIME_NETWORK_POLICY = "open";
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.RUNTIME_NETWORK_POLICY;
  Object.assign(process.env, origEnv);
});

describe("resolveNetworkPolicy", () => {
  it("无覆盖 → 继承全局默认 open", () => {
    const p = resolveNetworkPolicy({ runtimeType: "container" });
    expect(p.mode).toBe("open");
  });

  it("全局默认 disabled", () => {
    process.env.RUNTIME_NETWORK_POLICY = "disabled";
    const p = resolveNetworkPolicy({ runtimeType: "container" });
    expect(p.mode).toBe("disabled");
  });

  it("thread 覆盖 mode", () => {
    const p = resolveNetworkPolicy({
      runtimeType: "container",
      threadOverride: { mode: "disabled" },
    });
    expect(p.mode).toBe("disabled");
  });

  it("host 模式恒为 open（不可限制）", () => {
    process.env.RUNTIME_NETWORK_POLICY = "disabled";
    const p = resolveNetworkPolicy({
      runtimeType: "host",
      threadOverride: { mode: "disabled" },
    });
    expect(p.mode).toBe("open");
  });
});

describe("dockerNetworkMode", () => {
  it("disabled → none", () => {
    expect(dockerNetworkMode({ mode: "disabled" })).toBe("none");
  });

  it("open → undefined（默认 bridge）", () => {
    expect(dockerNetworkMode({ mode: "open" })).toBeUndefined();
  });
});

describe("S1 方案 B：allowlist 模式已删除", () => {
  // 守护：allowlist 模式不得复活，除非同时接通不可绕过的容器 egress 隔离（iptables/网络插件）。
  // 原 allowlist 与 disabled 等价却谎报"白名单模式"，契约不兑现。
  it("RUNTIME_NETWORK_POLICY=allowlist 启动即报错（不允许该值）", () => {
    process.env.RUNTIME_NETWORK_POLICY = "allowlist";
    expect(() => resolveNetworkPolicy({ runtimeType: "container" })).toThrow(
      /无效的 RUNTIME_NETWORK_POLICY/,
    );
  });

  it("P2-9: threadOverride.mode 非法值 → fail-closed 降级 disabled", () => {
    process.env.RUNTIME_NETWORK_POLICY = undefined;
    const p = resolveNetworkPolicy({
      runtimeType: "container",
      threadOverride: { mode: "allowlist" as unknown as "disabled" },
    });
    expect(p.mode).toBe("disabled");
  });
});
