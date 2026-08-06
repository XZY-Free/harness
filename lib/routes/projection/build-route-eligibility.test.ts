/**
 * Projection 构建器领域逻辑单元测试。
 *
 * 测试 eligibility 判定、specificity 计算等纯逻辑。
 * 不测试数据库交互（留给集成测试）。
 */

import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { computeSpecificity, normalizeEligibility } from "@/lib/routes/domain/route-selector";
import {
  computeNextVersion,
  computeProjectionContentDigest,
} from "@/lib/routes/projection/build-route-eligibility";
import { describe, expect, it } from "vitest";

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

// ─── §05.5: projectionContentDigest 测试 ──────────────────────

describe("§05.5 computeProjectionContentDigest", () => {
  it("相同字段产生相同 digest", () => {
    const fields = { routeId: "r1", agentId: "a1", eligibilityState: "eligible" };
    const d1 = computeProjectionContentDigest(fields);
    const d2 = computeProjectionContentDigest(fields);
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("不同字段产生不同 digest", () => {
    const d1 = computeProjectionContentDigest({ routeId: "r1", agentId: "a1" });
    const d2 = computeProjectionContentDigest({ routeId: "r2", agentId: "a1" });
    expect(d1).not.toBe(d2);
  });

  it("字段顺序不影响 digest", () => {
    const d1 = computeProjectionContentDigest({ a: 1, b: 2 });
    const d2 = computeProjectionContentDigest({ b: 2, a: 1 });
    expect(d1).toBe(d2);
  });
});

describe("§05.5 computeNextVersion", () => {
  it("现有行不存在 → version = 1", () => {
    expect(computeNextVersion(null, "sha256:abc")).toBe(1);
  });

  it("Digest 相同 → 不增加版本", () => {
    const existing = { projectionVersionNo: 3, projectionContentDigest: "sha256:abc" };
    expect(computeNextVersion(existing, "sha256:abc")).toBe(3);
  });

  it("Digest 变化 → 版本 +1", () => {
    const existing = { projectionVersionNo: 3, projectionContentDigest: "sha256:abc" };
    expect(computeNextVersion(existing, "sha256:def")).toBe(4);
  });

  it("连续变化 → 递增", () => {
    let existing: { projectionVersionNo: number; projectionContentDigest: string } | null = null;
    existing = { projectionVersionNo: computeNextVersion(existing, "sha256:v1"), projectionContentDigest: "sha256:v1" };
    expect(existing.projectionVersionNo).toBe(1);
    existing = { projectionVersionNo: computeNextVersion(existing, "sha256:v2"), projectionContentDigest: "sha256:v2" };
    expect(existing.projectionVersionNo).toBe(2);
    existing = { projectionVersionNo: computeNextVersion(existing, "sha256:v2"), projectionContentDigest: "sha256:v2" };
    expect(existing.projectionVersionNo).toBe(2); // same digest → no increase
    existing = { projectionVersionNo: computeNextVersion(existing, "sha256:v3"), projectionContentDigest: "sha256:v3" };
    expect(existing.projectionVersionNo).toBe(3);
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
