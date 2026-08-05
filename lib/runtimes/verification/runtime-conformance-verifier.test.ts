/**
 * Runtime Conformance 验证器 单元测试。
 */

import { describe, expect, it } from "vitest";
import {
  RUNTIME_CONFORMANCE_PREDICATE_TYPE,
  createDSSEConformanceVerifier,
  createLegacyHMACConformanceVerifier,
} from "./runtime-conformance-verifier";

describe("createDSSEConformanceVerifier", () => {
  it("Fail-closed 骨架: 未实现 SDK → verified=false, failureReason=verifier_not_implemented", async () => {
    const verifier = createDSSEConformanceVerifier({
      allowedRunnerIdentities: ["runner@ci.snowharness.dev"],
      readConformanceEnvelope: async () => Buffer.from("{}"),
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
    expect(result.conformanceFormat).toBe("standard_dsse");
    expect(result.predicateType).toBe(RUNTIME_CONFORMANCE_PREDICATE_TYPE);
    expect(result.failureReason).toBe("verifier_not_implemented");
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
