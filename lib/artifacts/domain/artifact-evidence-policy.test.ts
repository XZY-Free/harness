/**
 * Artifact Evidence 统一策略 单元测试。
 */

import { describe, expect, it } from "vitest";
import type { ArtifactEvidenceSnapshot } from "./artifact-evidence";
import { ArtifactEvidencePolicy, createArtifactEvidencePolicy } from "./artifact-evidence-policy";

function makeSnapshot(overrides: Partial<ArtifactEvidenceSnapshot> = {}): ArtifactEvidenceSnapshot {
  return {
    tenantId: "t1",
    artifactType: "runtime_revision",
    artifactRevisionId: "rev-1",
    artifactId: "artifact-1",
    artifactDigest: "sha256:aaa",
    attestationId: "att-1",
    verificationState: "verified",
    attestationFormat: "in_toto_dsse",
    verifiedAt: new Date(),
    revokedAt: null,
    revocationRecordId: null,
    verificationPolicyRevisionId: null,
    bundleDigest: "sha256:bbb",
    ...overrides,
  };
}

const validContext = {
  expectedTenantId: "t1",
  expectedArtifactType: "runtime_revision" as const,
  expectedRevisionId: "rev-1",
  expectedDigest: "sha256:aaa",
};

describe("ArtifactEvidencePolicy 基础规则", () => {
  it("完整有效证据 → valid=true", () => {
    const result = ArtifactEvidencePolicy.validateForPublication(makeSnapshot(), validContext);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("租户不一致 → evidence_tenant_mismatch", () => {
    const result = ArtifactEvidencePolicy.validateForPublication(
      makeSnapshot({ tenantId: "t2" }),
      validContext,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("evidence_tenant_mismatch");
  });

  it("制品类型不一致 → evidence_artifact_type_mismatch", () => {
    const result = ArtifactEvidencePolicy.validateForPublication(
      makeSnapshot({ artifactType: "agent_revision" }),
      validContext,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("evidence_artifact_type_mismatch");
  });

  it("Revision 绑定不一致 → evidence_revision_binding_mismatch", () => {
    const result = ArtifactEvidencePolicy.validateForPublication(
      makeSnapshot({ artifactRevisionId: "rev-other" }),
      validContext,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("evidence_revision_binding_mismatch");
  });

  it("未验证 → evidence_not_verified", () => {
    const result = ArtifactEvidencePolicy.validateForPublication(
      makeSnapshot({ verificationState: "failed" }),
      validContext,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("evidence_not_verified");
  });

  it("已撤销 → evidence_revoked", () => {
    const result = ArtifactEvidencePolicy.validateForPublication(
      makeSnapshot({ revokedAt: new Date(), revocationRecordId: "rev-rec-1" }),
      validContext,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("evidence_revoked");
  });

  it("Digest 不一致 → evidence_digest_mismatch", () => {
    const result = ArtifactEvidencePolicy.validateForPublication(
      makeSnapshot({ artifactDigest: "sha256:wrong" }),
      validContext,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("evidence_digest_mismatch");
  });

  it("expectedDigest=null 时跳过 Digest 检查", () => {
    const result = ArtifactEvidencePolicy.validateForPublication(
      makeSnapshot({ artifactDigest: "sha256:any" }),
      { ...validContext, expectedDigest: null },
    );
    expect(result.valid).toBe(true);
  });
});

describe("ArtifactEvidencePolicy 三个入口", () => {
  it("validateForPublication: legacy_custom 允许", () => {
    const result = ArtifactEvidencePolicy.validateForPublication(
      makeSnapshot({ attestationFormat: "legacy_custom" }),
      validContext,
    );
    expect(result.valid).toBe(true);
  });

  it("validateForRouteActivation: legacy_custom 允许", () => {
    const result = ArtifactEvidencePolicy.validateForRouteActivation(
      makeSnapshot({ attestationFormat: "legacy_custom" }),
      validContext,
    );
    expect(result.valid).toBe(true);
  });

  it("validateForNewExecution: legacy_custom 拒绝", () => {
    const result = ArtifactEvidencePolicy.validateForNewExecution(
      makeSnapshot({ attestationFormat: "legacy_custom" }),
      validContext,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("evidence_format_not_allowed");
  });

  it("validateForNewExecution: in_toto_dsse 允许", () => {
    const result = ArtifactEvidencePolicy.validateForNewExecution(
      makeSnapshot({ attestationFormat: "in_toto_dsse" }),
      validContext,
    );
    expect(result.valid).toBe(true);
  });
});

describe("createArtifactEvidencePolicy 自定义配置", () => {
  it("自定义执行允许格式", () => {
    const policy = createArtifactEvidencePolicy({
      allowedFormatsForExecution: ["legacy_custom", "in_toto_dsse"],
    });
    const result = policy.validateForNewExecution(
      makeSnapshot({ attestationFormat: "legacy_custom" }),
      validContext,
    );
    expect(result.valid).toBe(true);
  });
});
