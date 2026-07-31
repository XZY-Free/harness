/**
 * S12-W05：V11 网络出口策略单元测试。
 *
 * 覆盖：
 * - parseNetworkPolicy：裸 JSON → NetworkPolicy（含 fail-closed 默认值与非法格式）。
 * - mergeNetworkPolicies：多层合并（allow 交集 / deny 并集）。
 * - resolveEgressPolicy：environment → tenant → agent 三层合并。
 * - assertEgressAllowed：host/port 校验（deny 优先 / 空allowlist 全拒绝 / 私网 / loopback）。
 * - assertToolEgressAllowed：URL 解析 + 委托 assertEgressAllowed。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_NETWORK_POLICY,
  EgressPolicyError,
  type NetworkPolicy,
  STANDARD_ALLOWED_PORTS,
  assertEgressAllowed,
  assertToolEgressAllowed,
  mergeNetworkPolicies,
  parseNetworkPolicy,
  resolveEgressPolicy,
} from "@/lib/v11/capability/egress-policy";

// ─── parseNetworkPolicy ─────────────────────────────────────

describe("V11 parseNetworkPolicy", () => {
  it("null/undefined → DEFAULT_NETWORK_POLICY（fail-closed）", () => {
    expect(parseNetworkPolicy(null)).toEqual(DEFAULT_NETWORK_POLICY);
    expect(parseNetworkPolicy(undefined)).toEqual(DEFAULT_NETWORK_POLICY);
  });

  it("空对象 → allowEgress=false（fail-closed）", () => {
    const p = parseNetworkPolicy({});
    expect(p.allowEgress).toBe(false);
    expect(p.allowDomains).toEqual([]);
    expect(p.denyDomains).toEqual([]);
    expect(p.allowPrivateNetwork).toBe(false);
    expect(p.allowLoopback).toBe(false);
  });

  it("完整对象解析", () => {
    const p = parseNetworkPolicy({
      allowEgress: true,
      allowDomains: ["example.com", "*.google.com"],
      denyDomains: ["evil.com"],
      allowPorts: [443, 8443],
      denyPorts: [22],
      allowPrivateNetwork: true,
      allowLoopback: false,
    });
    expect(p.allowEgress).toBe(true);
    expect(p.allowDomains).toEqual(["example.com", "*.google.com"]);
    expect(p.denyDomains).toEqual(["evil.com"]);
    expect(p.allowPorts).toEqual([443, 8443]);
    expect(p.denyPorts).toEqual([22]);
    expect(p.allowPrivateNetwork).toBe(true);
    expect(p.allowLoopback).toBe(false);
  });

  it("allowEgress 缺省/false/非布尔 → false（严格布尔）", () => {
    expect(parseNetworkPolicy({ allowEgress: undefined }).allowEgress).toBe(false);
    expect(parseNetworkPolicy({ allowEgress: false }).allowEgress).toBe(false);
    expect(parseNetworkPolicy({ allowEgress: "true" }).allowEgress).toBe(false);
    expect(parseNetworkPolicy({ allowEgress: 1 }).allowEgress).toBe(false);
  });

  it("非对象 → policy_invalid", () => {
    expect(() => parseNetworkPolicy("string")).toThrow(EgressPolicyError);
    expect(() => parseNetworkPolicy(42)).toThrow(EgressPolicyError);
    expect(() => parseNetworkPolicy([])).toThrow(EgressPolicyError);
    try {
      parseNetworkPolicy("bad");
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("policy_invalid");
    }
  });

  it("allowDomains 非数组 → policy_invalid", () => {
    expect(() => parseNetworkPolicy({ allowDomains: "not-array" })).toThrow(EgressPolicyError);
  });

  it("allowDomains 元素非字符串 → policy_invalid", () => {
    expect(() => parseNetworkPolicy({ allowDomains: [1, 2] })).toThrow(EgressPolicyError);
  });

  it("allowPorts 元素非有限数字 → policy_invalid", () => {
    expect(() => parseNetworkPolicy({ allowPorts: [80, Number.NaN] })).toThrow(EgressPolicyError);
    expect(() => parseNetworkPolicy({ allowPorts: [80, "443"] })).toThrow(EgressPolicyError);
  });
});

// ─── mergeNetworkPolicies ───────────────────────────────────

describe("V11 mergeNetworkPolicies", () => {
  it("空数组 → DEFAULT_NETWORK_POLICY", () => {
    expect(mergeNetworkPolicies([])).toEqual(DEFAULT_NETWORK_POLICY);
  });

  it("单元素 → 原样返回", () => {
    const p: NetworkPolicy = {
      allowEgress: true,
      allowDomains: ["a.com"],
      denyDomains: ["b.com"],
      allowPorts: [443],
      denyPorts: [22],
      allowPrivateNetwork: false,
      allowLoopback: true,
    };
    expect(mergeNetworkPolicies([p])).toEqual(p);
  });

  it("allowEgress 任一 false → false（最严格）", () => {
    const merged = mergeNetworkPolicies([
      { ...DEFAULT_NETWORK_POLICY, allowEgress: true },
      { ...DEFAULT_NETWORK_POLICY, allowEgress: false },
    ]);
    expect(merged.allowEgress).toBe(false);
  });

  it("allowDomains 取交集", () => {
    const merged = mergeNetworkPolicies([
      { ...DEFAULT_NETWORK_POLICY, allowEgress: true, allowDomains: ["a.com", "b.com"] },
      { ...DEFAULT_NETWORK_POLICY, allowEgress: true, allowDomains: ["b.com", "c.com"] },
    ]);
    expect(merged.allowDomains).toEqual(["b.com"]);
  });

  it("denyDomains 取并集", () => {
    const merged = mergeNetworkPolicies([
      { ...DEFAULT_NETWORK_POLICY, allowEgress: true, denyDomains: ["evil.com"] },
      { ...DEFAULT_NETWORK_POLICY, allowEgress: true, denyDomains: ["bad.com"] },
    ]);
    expect([...merged.denyDomains].sort()).toEqual(["bad.com", "evil.com"]);
  });

  it("allowPorts 取交集", () => {
    const merged = mergeNetworkPolicies([
      { ...DEFAULT_NETWORK_POLICY, allowEgress: true, allowPorts: [80, 443] },
      { ...DEFAULT_NETWORK_POLICY, allowEgress: true, allowPorts: [443, 8443] },
    ]);
    expect(merged.allowPorts).toEqual([443]);
  });

  it("denyPorts 取并集", () => {
    const merged = mergeNetworkPolicies([
      { ...DEFAULT_NETWORK_POLICY, allowEgress: true, denyPorts: [22] },
      { ...DEFAULT_NETWORK_POLICY, allowEgress: true, denyPorts: [25] },
    ]);
    expect(Array.from(merged.denyPorts).sort()).toEqual([22, 25]);
  });

  it("allowPrivateNetwork/allowLoopback 任一 false → false", () => {
    const merged = mergeNetworkPolicies([
      { ...DEFAULT_NETWORK_POLICY, allowPrivateNetwork: true, allowLoopback: true },
      { ...DEFAULT_NETWORK_POLICY, allowPrivateNetwork: false, allowLoopback: true },
    ]);
    expect(merged.allowPrivateNetwork).toBe(false);
    expect(merged.allowLoopback).toBe(true);
  });
});

// ─── resolveEgressPolicy ────────────────────────────────────

describe("V11 resolveEgressPolicy", () => {
  it("三层均空 → DEFAULT_NETWORK_POLICY", () => {
    expect(resolveEgressPolicy({})).toEqual(DEFAULT_NETWORK_POLICY);
  });

  it("environment allowEgress=false → 整体拒绝（即使 tenant/agent 允许）", () => {
    const result = resolveEgressPolicy({
      environmentPolicy: { ...DEFAULT_NETWORK_POLICY, allowEgress: false },
      tenantPolicy: { ...DEFAULT_NETWORK_POLICY, allowEgress: true, allowDomains: ["a.com"] },
      agentPolicy: { ...DEFAULT_NETWORK_POLICY, allowEgress: true, allowDomains: ["a.com"] },
    });
    expect(result.allowEgress).toBe(false);
  });

  it("三层 allowDomains 取交集", () => {
    const result = resolveEgressPolicy({
      environmentPolicy: {
        ...DEFAULT_NETWORK_POLICY,
        allowEgress: true,
        allowDomains: ["a.com", "b.com", "c.com"],
      },
      tenantPolicy: {
        ...DEFAULT_NETWORK_POLICY,
        allowEgress: true,
        allowDomains: ["a.com", "b.com"],
      },
      agentPolicy: {
        ...DEFAULT_NETWORK_POLICY,
        allowEgress: true,
        allowDomains: ["a.com"],
      },
    });
    expect(result.allowDomains).toEqual(["a.com"]);
  });
});

// ─── assertEgressAllowed ────────────────────────────────────

describe("V11 assertEgressAllowed", () => {
  const basePolicy: NetworkPolicy = {
    allowEgress: true,
    allowDomains: ["example.com", "*.google.com"],
    denyDomains: ["evil.com"],
    allowPorts: [],
    denyPorts: [],
    allowPrivateNetwork: false,
    allowLoopback: false,
  };

  it("allowEgress=false → egress_disabled", () => {
    expect(() => assertEgressAllowed({ ...basePolicy, allowEgress: false }, "example.com")).toThrow(
      EgressPolicyError,
    );
    try {
      assertEgressAllowed({ ...basePolicy, allowEgress: false }, "example.com");
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("egress_disabled");
    }
  });

  it("命中 denyDomains → domain_denied（优先于 allow）", () => {
    expect(() => assertEgressAllowed(basePolicy, "evil.com")).toThrow(EgressPolicyError);
    try {
      assertEgressAllowed(basePolicy, "evil.com");
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("domain_denied");
    }
  });

  it("未命中 allowDomains → domain_not_allowed", () => {
    expect(() => assertEgressAllowed(basePolicy, "unknown.com")).toThrow(EgressPolicyError);
    try {
      assertEgressAllowed(basePolicy, "unknown.com");
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("domain_not_allowed");
    }
  });

  it("空 allowDomains → domain_not_allowed（fail-closed）", () => {
    const p: NetworkPolicy = { ...basePolicy, allowDomains: [] };
    expect(() => assertEgressAllowed(p, "example.com")).toThrow(EgressPolicyError);
    try {
      assertEgressAllowed(p, "example.com");
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("domain_not_allowed");
    }
  });

  it("精确匹配 allowDomains → 通过", () => {
    expect(() => assertEgressAllowed(basePolicy, "example.com")).not.toThrow();
  });

  it("通配符匹配子域 *.google.com → 通过", () => {
    expect(() => assertEgressAllowed(basePolicy, "api.google.com")).not.toThrow();
    expect(() => assertEgressAllowed(basePolicy, "www.google.com")).not.toThrow();
  });

  it("通配符匹配根域 google.com → 通过", () => {
    expect(() => assertEgressAllowed(basePolicy, "google.com")).not.toThrow();
  });

  it("通配符不匹配其他域 → 拒绝", () => {
    expect(() => assertEgressAllowed(basePolicy, "notgoogle.com")).toThrow(EgressPolicyError);
  });

  it("私网地址 + allowPrivateNetwork=false → private_network_blocked", () => {
    expect(() => assertEgressAllowed(basePolicy, "10.0.0.1")).toThrow(EgressPolicyError);
    try {
      assertEgressAllowed(basePolicy, "10.0.0.1");
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("private_network_blocked");
    }
  });

  it("私网 192.168.x.x 被阻止", () => {
    expect(() => assertEgressAllowed(basePolicy, "192.168.1.1")).toThrow(EgressPolicyError);
  });

  it("私网 172.16-31.x.x 被阻止", () => {
    expect(() => assertEgressAllowed(basePolicy, "172.16.0.1")).toThrow(EgressPolicyError);
    expect(() => assertEgressAllowed(basePolicy, "172.31.255.255")).toThrow(EgressPolicyError);
  });

  it("172.15.x.x 不被私网规则阻止（但会被 allowDomains 拒绝）", () => {
    expect(() => assertEgressAllowed(basePolicy, "172.15.0.1")).toThrow(EgressPolicyError);
    try {
      assertEgressAllowed(basePolicy, "172.15.0.1");
    } catch (e) {
      // 172.15 不在私网范围，但不在 allowDomains → domain_not_allowed
      expect((e as EgressPolicyError).code).toBe("domain_not_allowed");
    }
  });

  it("私网 + allowPrivateNetwork=true → 通过（但需在 allowDomains）", () => {
    const p: NetworkPolicy = {
      ...basePolicy,
      allowDomains: ["10.0.0.1"],
      allowPrivateNetwork: true,
    };
    expect(() => assertEgressAllowed(p, "10.0.0.1")).not.toThrow();
  });

  it("loopback 127.0.0.1 + allowLoopback=false → loopback_blocked", () => {
    const p: NetworkPolicy = {
      ...basePolicy,
      allowDomains: ["127.0.0.1"],
    };
    expect(() => assertEgressAllowed(p, "127.0.0.1")).toThrow(EgressPolicyError);
    try {
      assertEgressAllowed(p, "127.0.0.1");
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("loopback_blocked");
    }
  });

  it("loopback localhost + allowLoopback=false → loopback_blocked", () => {
    const p: NetworkPolicy = { ...basePolicy, allowDomains: ["localhost"] };
    expect(() => assertEgressAllowed(p, "localhost")).toThrow(EgressPolicyError);
  });

  it("loopback + allowLoopback=true → 通过（但需在 allowDomains）", () => {
    const p: NetworkPolicy = {
      ...basePolicy,
      allowDomains: ["127.0.0.1"],
      allowLoopback: true,
    };
    expect(() => assertEgressAllowed(p, "127.0.0.1")).not.toThrow();
  });

  it("端口命中 denyPorts → port_denied", () => {
    const p: NetworkPolicy = { ...basePolicy, denyPorts: [22] };
    expect(() => assertEgressAllowed(p, "example.com", 22)).toThrow(EgressPolicyError);
    try {
      assertEgressAllowed(p, "example.com", 22);
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("port_denied");
    }
  });

  it("端口不在 allowPorts → port_not_allowed", () => {
    const p: NetworkPolicy = { ...basePolicy, allowPorts: [443] };
    expect(() => assertEgressAllowed(p, "example.com", 8080)).toThrow(EgressPolicyError);
    try {
      assertEgressAllowed(p, "example.com", 8080);
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("port_not_allowed");
    }
  });

  it("allowPorts 为空 → 默认允许 80/443（STANDARD_ALLOWED_PORTS）", () => {
    expect(STANDARD_ALLOWED_PORTS).toEqual([80, 443]);
    const p: NetworkPolicy = { ...basePolicy, allowPorts: [] };
    expect(() => assertEgressAllowed(p, "example.com", 80)).not.toThrow();
    expect(() => assertEgressAllowed(p, "example.com", 443)).not.toThrow();
    expect(() => assertEgressAllowed(p, "example.com", 8080)).toThrow(EgressPolicyError);
  });

  it("host 大小写无关", () => {
    expect(() => assertEgressAllowed(basePolicy, "EXAMPLE.COM")).not.toThrow();
    expect(() => assertEgressAllowed(basePolicy, "API.Google.COM")).not.toThrow();
  });
});

// ─── assertToolEgressAllowed ────────────────────────────────

describe("V11 assertToolEgressAllowed", () => {
  const basePolicy: NetworkPolicy = {
    allowEgress: true,
    allowDomains: ["example.com"],
    denyDomains: [],
    allowPorts: [],
    denyPorts: [],
    allowPrivateNetwork: false,
    allowLoopback: false,
  };

  it("https URL → 提取 host + 默认端口 443", () => {
    expect(() => assertToolEgressAllowed(basePolicy, "https://example.com/path")).not.toThrow();
  });

  it("http URL → 提取 host + 默认端口 80", () => {
    expect(() => assertToolEgressAllowed(basePolicy, "http://example.com/path")).not.toThrow();
  });

  it("显式端口覆盖默认端口", () => {
    const p: NetworkPolicy = { ...basePolicy, allowPorts: [8443] };
    expect(() => assertToolEgressAllowed(p, "https://example.com:8443/path")).not.toThrow();
  });

  it("URL 解析失败 → policy_invalid", () => {
    expect(() => assertToolEgressAllowed(basePolicy, "not-a-url")).toThrow(EgressPolicyError);
    try {
      assertToolEgressAllowed(basePolicy, "not-a-url");
    } catch (e) {
      expect((e as EgressPolicyError).code).toBe("policy_invalid");
    }
  });

  it("URL host 不在 allowDomains → domain_not_allowed", () => {
    expect(() => assertToolEgressAllowed(basePolicy, "https://evil.com")).toThrow(
      EgressPolicyError,
    );
  });
});
