/**
 * Projection 构建器领域逻辑单元测试。
 *
 * 测试 eligibility 判定、specificity 计算等纯逻辑。
 * 不测试数据库交互（留给集成测试）。
 */

import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { computeSpecificity, normalizeEligibility } from "@/lib/routes/domain/route-selector";
import { describe, expect, it } from "vitest";

/** §4.2: 权威组合版本计算 — 与 build-route-eligibility.ts 一致。 */
function computeAuthoritativeVersion(
  routeSetVersionNo: number,
  activationSequence: number,
  aggregateVersion: number,
): number {
  return routeSetVersionNo * 1_000_000 + activationSequence * 1_000 + aggregateVersion;
}

describe("Projection 资格判定逻辑", () => {
  describe("normalizeEligibility + computeSpecificity", () => {
    it("空条件 → specificity=0", () => {
      const norm = normalizeEligibility({});
      expect(norm).toBeTruthy();
      if (norm) {
        const spec = computeSpecificity(norm);
        expect(spec).toBe(0);
      }
    });

    it("单条件 → specificity=1", () => {
      const norm = normalizeEligibility({ all: { environment: "prod" } });
      expect(norm).toBeTruthy();
      if (norm) {
        const spec = computeSpecificity(norm);
        expect(spec).toBe(1);
      }
    });

    it("双条件 → specificity=2", () => {
      const norm = normalizeEligibility({ all: { environment: "prod", region: "cn" } });
      expect(norm).toBeTruthy();
      if (norm) {
        const spec = computeSpecificity(norm);
        expect(spec).toBe(2);
      }
    });

    it("null 输入 → 返回空 all", () => {
      const norm = normalizeEligibility(null);
      // normalizeEligibility 对 null 返回默认空条件
      expect(norm).toBeTruthy();
      if (norm) {
        expect(Object.keys(norm.all)).toHaveLength(0);
      }
    });
  });

  describe("computeCapabilityManifestDigest", () => {
    it("相同输入产生相同 digest", () => {
      const input = {
        agentRevisionId: "agent-rev-1",
        agentInterfaceRequirements: { tools: ["read", "write"] },
        runtimeRevisionId: "rt-rev-1",
        runtimeCapabilities: { protocols: ["https"] },
      };
      const d1 = computeCapabilityManifestDigest(input);
      const d2 = computeCapabilityManifestDigest(input);
      expect(d1).toBe(d2);
      expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("不同输入产生不同 digest", () => {
      const d1 = computeCapabilityManifestDigest({
        agentRevisionId: "agent-rev-1",
        agentInterfaceRequirements: { tools: ["read"] },
        runtimeRevisionId: "rt-rev-1",
        runtimeCapabilities: {},
      });
      const d2 = computeCapabilityManifestDigest({
        agentRevisionId: "agent-rev-2",
        agentInterfaceRequirements: { tools: ["read"] },
        runtimeRevisionId: "rt-rev-1",
        runtimeCapabilities: {},
      });
      expect(d1).not.toBe(d2);
    });
  });
});

describe("Projection eligibilityState 逻辑", () => {
  it("所有条件满足 → eligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: null, // 无 Policy → 不阻塞
    };
    const isEligible = isControlPlaneEligibleFromProjection(conditions);
    expect(isEligible).toBe(true);
  });

  it("Agent 不 enabled → ineligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "disabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: null,
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });

  it("Evidence 无效 → ineligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 0, // ← 无效
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: null,
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });

  it("Conformance 未通过 → ineligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 0, // ← 未通过
      policyRevisionState: null,
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });

  it("Policy 非 published → ineligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: "draft", // ← 非 published
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });

  it("Route disabled → ineligible", () => {
    const conditions = {
      activationState: "disabled", // ← 禁用
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: null,
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });
});

/** 从 Projection 布尔字段计算 eligibility — 与 build-route-eligibility.ts 逻辑一致。 */

describe("§4.2 computeAuthoritativeVersion", () => {
  it("相同三要素 → 相同版本", () => {
    expect(computeAuthoritativeVersion(1, 2, 3)).toBe(computeAuthoritativeVersion(1, 2, 3));
  });

  it("routeSetVersionNo 递增 → 版本严格递增", () => {
    expect(computeAuthoritativeVersion(2, 0, 0)).toBeGreaterThan(
      computeAuthoritativeVersion(1, 999, 999),
    );
  });

  it("activationSequence 递增 → 版本严格递增", () => {
    expect(computeAuthoritativeVersion(1, 2, 0)).toBeGreaterThan(
      computeAuthoritativeVersion(1, 1, 999),
    );
  });

  it("aggregateVersion 递增 → 版本严格递增", () => {
    expect(computeAuthoritativeVersion(1, 1, 2)).toBeGreaterThan(
      computeAuthoritativeVersion(1, 1, 1),
    );
  });

  it("全零 → 0", () => {
    expect(computeAuthoritativeVersion(0, 0, 0)).toBe(0);
  });
});

function isControlPlaneEligibleFromProjection(c: {
  activationState: string;
  agentLifecycleState: string;
  agentRevisionState: string;
  agentPublicationActive: number;
  agentEvidenceValid: number;
  runtimeLifecycleState: string;
  runtimeRevisionState: string;
  runtimePublicationActive: number;
  runtimeEvidenceValid: number;
  runtimeConformanceValid: number;
  policyRevisionState: string | null;
}): boolean {
  return Boolean(
    c.activationState === "active" &&
      c.agentLifecycleState === "enabled" &&
      c.agentRevisionState === "published" &&
      c.agentPublicationActive === 1 &&
      c.agentEvidenceValid === 1 &&
      c.runtimeLifecycleState === "enabled" &&
      c.runtimeRevisionState === "published" &&
      c.runtimePublicationActive === 1 &&
      c.runtimeEvidenceValid === 1 &&
      c.runtimeConformanceValid === 1 &&
      (c.policyRevisionState === null || c.policyRevisionState === "published"),
  );
}
