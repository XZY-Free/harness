/**
 * Runtime Conformance 验证器 单元测试。
 */

import { describe, it, expect } from "vitest";
import {
  createDSSEConformanceVerifier,
  createLegacyHMACConformanceVerifier,
  RUNTIME_CONFORMANCE_PREDICATE_TYPE,
} from "./runtime-conformance-verifier";

describe("createDSSEConformanceVerifier", () => {
  it("DSSE 验证成功 → verified=true, format=standard_dsse", async () => {
    const verifier = createDSSEConformanceVerifier({
      allowedRunnerIdentities: ["runner@ci.snowharness.dev"],
    });
    const result = await verifier.verify({
      runId: "run-1",
      expectedRuntimeRevisionId: "rt-rev-1",
      expectedRuntimeArtifactDigest: "sha256:aaa",
      expectedRuntimeConfigDigest: "sha256:bbb",
      expectedProtocolContractRevision: "v1",
      tenantId: "t1",
    });
    expect(result.verified).toBe(true);
    expect(result.conformanceFormat).toBe("standard_dsse");
    expect(result.predicateType).toBe(RUNTIME_CONFORMANCE_PREDICATE_TYPE);
  });
});

describe("createLegacyHMACConformanceVerifier", () => {
  it("过渡期: allowNewHmacReports=true → verified=true", async () => {
    const verifier = createLegacyHMACConformanceVerifier({
      allowNewHmacReports: true,
    });
    const result = await verifier.verify({
      runId: "run-1",
      expectedRuntimeRevisionId: "rt-rev-1",
      expectedRuntimeArtifactDigest: "sha256:aaa",
      expectedRuntimeConfigDigest: "sha256:bbb",
      expectedProtocolContractRevision: "v1",
      tenantId: "t1",
    });
    expect(result.verified).toBe(true);
    expect(result.conformanceFormat).toBe("legacy_hmac");
  });

  it("生产: allowNewHmacReports=false → verified=false", async () => {
    const verifier = createLegacyHMACConformanceVerifier({
      allowNewHmacReports: false,
    });
    const result = await verifier.verify({
      runId: "run-1",
      expectedRuntimeRevisionId: "rt-rev-1",
      expectedRuntimeArtifactDigest: "sha256:aaa",
      expectedRuntimeConfigDigest: "sha256:bbb",
      expectedProtocolContractRevision: "v1",
      tenantId: "t1",
    });
    expect(result.verified).toBe(false);
    expect(result.failureReason).toContain("拒绝新 legacy_hmac");
  });
});

describe("RUNTIME_CONFORMANCE_PREDICATE_TYPE", () => {
  it("是稳定 HTTPS URI", () => {
    expect(RUNTIME_CONFORMANCE_PREDICATE_TYPE).toMatch(/^https:\/\//);
    expect(RUNTIME_CONFORMANCE_PREDICATE_TYPE).not.toContain("localhost");
    expect(RUNTIME_CONFORMANCE_PREDICATE_TYPE).not.toContain("git");
  });
});
