/**
 * Runtime Conformance 验证器 单元测试。
 *
 * 使用真实 Ed25519 密钥对生成签名 Envelope，验证成功和各种失败场景。
 */

import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { computeDssePae } from "@/lib/crypto/dsse";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import { PUBLICATION_CONFORMANCE_SUITE_REVISION } from "@/lib/runtime/domain/runtime-conformance-contract";
import type { RuntimeConformanceReport } from "@/lib/runtime/domain/runtime-conformance-run";
import {
  buildDsseConformanceEnvelope,
  buildTestConformanceReport,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_CONFORMANCE_PREDICATE_TYPE,
  createDSSEConformanceVerifier,
} from "./runtime-conformance-verifier";

const RUNNER_IDENTITY = "ci/runtime-conformance";

function createVerifierWithKey(key: ReturnType<typeof generateTestRunnerKey>) {
  return createDSSEConformanceVerifier({
    runnerIdentityRegistry: new RunnerSigningIdentityRegistry([
      {
        keyId: key.keyid,
        publicKey: key.publicKeyBase64,
        runnerIdentity: RUNNER_IDENTITY,
        tenantScope: null,
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: null,
        revokedAt: null,
      },
    ]),
  });
}

function createBaseInput(envelopeJson: string, report = buildTestConformanceReport("rev-1")) {
  return {
    dsseEnvelopeBytes: Buffer.from(envelopeJson, "utf-8"),
    expectedRuntimeRevisionId: report.runtimeRevisionId,
    expectedRuntimeTargetDigest: report.runtimeTargetDigest,
    expectedRuntimeConfigDigest: report.runtimeConfigDigest,
    expectedProtocolContractRevision: report.protocolContractRevision,
    tenantId: "t1",
  };
}

describe("createDSSEConformanceVerifier", () => {
  it("合法 DSSE Envelope 验签成功，返回 VerifiedRuntimeConformanceClaims", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const envelope = buildDsseConformanceEnvelope(report, key);

    const result = await verifier.verify(createBaseInput(envelope, report));

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.claims.signingKeyId).toBe("runner-key-1");
      expect(result.claims.runnerIdentity).toBe(RUNNER_IDENTITY);
      expect(result.claims.predicateType).toBe(RUNTIME_CONFORMANCE_PREDICATE_TYPE);
      expect(result.claims.verificationEngine).toBe("dsse-ed25519");
      expect(result.claims.envelopeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.claims.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.claims.report.runtimeRevisionId).toBe("rev-1");
    }
  });

  it("Envelope JSON 损坏 → dsse_envelope_json_parse_failed", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const result = await verifier.verify({
      ...createBaseInput("{not valid json"),
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("dsse_envelope_json_parse_failed");
  });

  it("payloadType 缺失 → dsse_payload_type_missing", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const envelope = JSON.stringify({ payload: "e30=", signatures: [{ keyid: "k", sig: "s" }] });
    const result = await verifier.verify(createBaseInput(envelope));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("dsse_payload_type_missing");
  });

  it("payload 缺失 → dsse_payload_missing", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const envelope = JSON.stringify({
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ keyid: "k", sig: "s" }],
    });
    const result = await verifier.verify(createBaseInput(envelope));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("dsse_payload_missing");
  });

  it("signatures 空数组 → dsse_signatures_missing", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const envelope = JSON.stringify({
      payloadType: "application/vnd.in-toto+json",
      payload: "e30=",
      signatures: [],
    });
    const result = await verifier.verify(createBaseInput(envelope));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("dsse_signatures_missing");
  });

  it("未知 keyid → unknown_keyid", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const otherKey = generateTestRunnerKey("other-key");
    const envelope = buildDsseConformanceEnvelope(report, otherKey);

    const result = await verifier.verify(createBaseInput(envelope, report));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("unknown_keyid");
  });

  it("签名被修改 → signature_invalid", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const envelope = buildDsseConformanceEnvelope(report, key);
    const env = JSON.parse(envelope);
    env.signatures[0].sig = Buffer.from("tampered-signature").toString("base64");

    const result = await verifier.verify(createBaseInput(JSON.stringify(env), report));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("signature_invalid");
  });

  it("in-toto Statement _type 错误 → in_toto_statement_type_invalid", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const statement = {
      _type: "https://in-toto.io/Statement/v0",
      subject: [
        {
          name: "runtime-artifact",
          digest: { sha256: report.runtimeTargetDigest.replace("sha256:", "") },
        },
      ],
      predicateType: RUNTIME_CONFORMANCE_PREDICATE_TYPE,
      predicate: report,
    };
    const payloadBytes = Buffer.from(JSON.stringify(statement), "utf-8");
    const envelope = buildEnvelopeWithPayload(payloadBytes, key);
    const result = await verifier.verify(createBaseInput(envelope, report));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("in_toto_statement_type_invalid");
  });

  it("predicateType 不匹配 → predicate_type_mismatch", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: "runtime-artifact",
          digest: { sha256: report.runtimeTargetDigest.replace("sha256:", "") },
        },
      ],
      predicateType: "https://example.com/wrong-predicate",
      predicate: report,
    };
    const payloadBytes = Buffer.from(JSON.stringify(statement), "utf-8");
    const envelope = buildEnvelopeWithPayload(payloadBytes, key);
    const result = await verifier.verify(createBaseInput(envelope, report));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("predicate_type_mismatch");
  });

  it("Subject Digest 不一致 → subject_digest_mismatch", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "runtime-artifact", digest: { sha256: "deadbeef".repeat(16) } }],
      predicateType: RUNTIME_CONFORMANCE_PREDICATE_TYPE,
      predicate: report,
    };
    const payloadBytes = Buffer.from(JSON.stringify(statement), "utf-8");
    const envelope = buildEnvelopeWithPayload(payloadBytes, key);
    const result = await verifier.verify(createBaseInput(envelope, report));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("subject_digest_mismatch");
  });

  it("runtimeRevisionId 不一致 → runtime_revision_mismatch", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1", { runtimeRevisionId: "wrong-rev" });
    const envelope = buildDsseConformanceEnvelope(report, key);
    const result = await verifier.verify({
      ...createBaseInput(envelope, buildTestConformanceReport("rev-1")),
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("runtime_revision_mismatch");
  });

  it("Runtime Target Digest 不一致 → target_digest_mismatch", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const envelope = buildDsseConformanceEnvelope(report, key);
    const result = await verifier.verify({
      ...createBaseInput(envelope, report),
      expectedRuntimeTargetDigest: `sha256:${"f".repeat(64)}`,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("target_digest_mismatch");
  });

  it("Config Digest 不一致 → config_digest_mismatch", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const envelope = buildDsseConformanceEnvelope(report, key);
    const result = await verifier.verify({
      ...createBaseInput(envelope, report),
      expectedRuntimeConfigDigest: `sha256:${"f".repeat(64)}`,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("config_digest_mismatch");
  });

  it("Protocol Revision 不一致 → protocol_revision_mismatch", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const envelope = buildDsseConformanceEnvelope(report, key);
    const result = await verifier.verify({
      ...createBaseInput(envelope, report),
      expectedProtocolContractRevision: "wrong-protocol@1",
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("protocol_revision_mismatch");
  });

  it("Runner Identity 不允许 → runner_key_identity_mismatch", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createDSSEConformanceVerifier({
      runnerIdentityRegistry: new RunnerSigningIdentityRegistry([
        {
          keyId: key.keyid,
          publicKey: key.publicKeyBase64,
          runnerIdentity: "other-runner",
          tenantScope: null,
          validFrom: "2020-01-01T00:00:00.000Z",
          validUntil: null,
          revokedAt: null,
        },
      ]),
    });
    const report = buildTestConformanceReport("rev-1");
    const envelope = buildDsseConformanceEnvelope(report, key);
    const result = await verifier.verify(createBaseInput(envelope, report));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("runner_key_identity_mismatch");
  });

  it("suiteRevision 不一致 → suite_revision_mismatch", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1", { suiteRevision: "wrong@1" });
    const envelope = buildDsseConformanceEnvelope(report, key);
    const result = await verifier.verify(createBaseInput(envelope, report));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("suite_revision_mismatch");
  });

  it("Case 缺失 → case_results_incomplete", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const incompleteReport = { ...report, caseResults: report.caseResults.slice(0, 5) };
    const envelope = buildDsseConformanceEnvelope(incompleteReport, key);
    const result = await verifier.verify(createBaseInput(envelope, incompleteReport));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("case_results_incomplete");
  });

  it("Case 重复 → case_results_not_unique", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const dupReport = {
      ...report,
      caseResults: [...report.caseResults, { ...report.caseResults[0]! }],
    };
    const envelope = buildDsseConformanceEnvelope(dupReport, key);
    const result = await verifier.verify(createBaseInput(envelope, dupReport));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("case_results_not_unique");
  });

  it("overallResult 与 case 结果不一致 → overall_result_inconsistent", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1", { overallResult: "failed" });
    const envelope = buildDsseConformanceEnvelope(report, key);
    const result = await verifier.verify(createBaseInput(envelope, report));
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.failureReason).toBe("overall_result_inconsistent");
  });

  it("签名有效但篡改 case evidence.caseId → verified=false（证据自洽校验）", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const tampered: RuntimeConformanceReport = {
      ...report,
      caseResults: report.caseResults.map((r, index) =>
        index === 0 ? { ...r, evidence: { ...r.evidence, caseId: "tampered-case" } } : r,
      ),
    };
    const envelope = buildDsseConformanceEnvelope(tampered, key);
    const result = await verifier.verify(createBaseInput(envelope, tampered));
    expect(result.verified).toBe(false);
  });

  it("签名有效但篡改 case evidenceDigest → verified=false（证据自洽校验）", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const tampered: RuntimeConformanceReport = {
      ...report,
      caseResults: report.caseResults.map((r, index) =>
        index === 0 ? { ...r, evidenceDigest: `sha256:${"f".repeat(64)}` } : r,
      ),
    };
    const envelope = buildDsseConformanceEnvelope(tampered, key);
    const result = await verifier.verify(createBaseInput(envelope, tampered));
    expect(result.verified).toBe(false);
  });

  it("签名有效但篡改 evidenceManifestDigest → verified=false（证据自洽校验）", async () => {
    const key = generateTestRunnerKey("runner-key-1");
    const verifier = createVerifierWithKey(key);
    const report = buildTestConformanceReport("rev-1");
    const tampered: RuntimeConformanceReport = {
      ...report,
      evidenceManifestDigest: `sha256:${"f".repeat(64)}`,
    };
    const envelope = buildDsseConformanceEnvelope(tampered, key);
    const result = await verifier.verify(createBaseInput(envelope, tampered));
    expect(result.verified).toBe(false);
  });
});

describe("RUNTIME_CONFORMANCE_PREDICATE_TYPE", () => {
  it("是稳定 HTTPS URI", () => {
    expect(RUNTIME_CONFORMANCE_PREDICATE_TYPE).toMatch(/^https:\/\//);
    expect(RUNTIME_CONFORMANCE_PREDICATE_TYPE).not.toContain("localhost");
    expect(RUNTIME_CONFORMANCE_PREDICATE_TYPE).not.toContain("git");
  });
});

describe("PUBLICATION_CONFORMANCE_SUITE_REVISION", () => {
  it("与测试 report 默认值一致", () => {
    expect(PUBLICATION_CONFORMANCE_SUITE_REVISION).toBe("runtime-conformance@1");
  });
});

function buildEnvelopeWithPayload(
  payloadBytes: Buffer,
  key: ReturnType<typeof generateTestRunnerKey>,
): string {
  const payloadType = "application/vnd.in-toto+json";
  const pae = computeDssePae(payloadType, payloadBytes);
  const privateKey = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(key.publicKeyBase64, "base64").toString("base64url"),
      d: Buffer.from(key.privateKey).toString("base64url"),
    },
    format: "jwk",
  });
  const signature = cryptoSign(null, pae, privateKey);
  const envelope = {
    payloadType,
    payload: payloadBytes.toString("base64"),
    signatures: [{ keyid: key.keyid, sig: signature.toString("base64") }],
  };
  return JSON.stringify(envelope);
}
