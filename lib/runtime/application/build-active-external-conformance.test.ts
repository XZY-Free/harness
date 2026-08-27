/**
 * Active external A2A Runtime Publication Conformance 报告/签名边界行为测试（RED）。
 *
 * 冻结的待实现生产 API：
 *   lib/runtime/application/build-active-external-conformance.ts
 *   export function buildActiveExternalConformanceReport(input): {
 *     report: RuntimeConformanceReport;
 *     dsseEnvelopeJson: string;
 *   }
 *
 * 输入只绑定租户无关报告事实 + 显式 Ed25519 signer 描述符（keyId /
 * runnerIdentity / PKCS8 私钥 base64）；不存在 prompt / transcript /
 * credential / AgentCard body 输入。输出为 exact report + DSSE envelope JSON。
 *
 * 语义（六 case，全部来自真实已完成的黑盒 probe 事实）：
 * 1 capability-manifest-contract：AgentCard 协议/transport/streaming 一致性 +
 *   declared/effective feature 布尔。
 * 2 dispatch-acknowledgement：basic_invocation=pass + 真实流式测量（如适用）。
 * 3 cancel-acknowledgement：cancel=false 只能以「诚实不支持」通过（declared=false /
 *   measured=not_applicable / effective=false，绝不宣称 ack）；cancel=true 仅在
 *   measured=pass 且 effective=true 时通过。
 * 4 steer-capability-consistency：外部导入 A2A 合同无 steer 能力，显式 unsupported。
 * 5 resume-capability-consistency：false 仅 not_applicable/effective=false 通过；
 *   true 仅 measured=pass/effective=true 通过。
 * 6 session-recovery-declaration：durable=false 诚实不支持通过；durable=true 且
 *   not_measured/effective=false 必须 fail closed → overallResult=failed。
 */

import { generateKeyPairSync } from "node:crypto";
import {
  type ActiveExternalConformanceBuilderInput,
  buildActiveExternalConformanceReport,
} from "@/lib/runtime/application/build-active-external-conformance";
import type {
  RuntimeCapabilitiesProjection,
  RuntimeMeasuredEvidence,
} from "@/lib/runtime/application/register-agent-runtime";
import {
  RUNTIME_CONFORMANCE_PREDICATE_TYPE,
  type VerifyConformanceInput,
  createDSSEConformanceVerifier,
} from "@/lib/runtime/conformance/runtime-conformance-verifier";
import type { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import { RunnerSigningIdentityRegistry as Registry } from "@/lib/runtime/domain/runner-signing-identity";
import {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  type RuntimeConformanceReport,
  computeCaseEvidenceDigest,
  computeEvidenceManifestDigest,
  validateRuntimeConformanceReport,
} from "@/lib/runtime/domain/runtime-conformance-run";
import {
  generateEd25519SignerKeyPair,
  generateRsaPkcs8PrivateKeyBase64,
} from "@/lib/runtime/test-support/ed25519-signer-keypair";
import { describe, expect, it } from "vitest";

// ─── 输入类型冻结：禁止 prompt/transcript/credential/AgentCard body ──

type BuilderInput = Parameters<typeof buildActiveExternalConformanceReport>[0];
type ForbiddenKey =
  | "prompt"
  | "prompts"
  | "transcript"
  | "transcripts"
  | "credential"
  | "credentialRefId"
  | "credentials"
  | "apiKey"
  | "agentCard"
  | "agentCardJson";
type PresentForbiddenKeys = Extract<keyof BuilderInput, ForbiddenKey>;
// 若 BuilderInput 含任一禁止键，PresentForbiddenKeys 非 never，此赋值编译失败。
const forbiddenKeyAbsent: never = null as unknown as PresentForbiddenKeys;
void forbiddenKeyAbsent;

// ─── 测试夹具 ─────────────────────────────────────────────

const TENANT_ID = "tenant-hr";
const SIGNER_KEY = generateEd25519SignerKeyPair();

function measuredEvidenceFor(features: {
  streaming: boolean;
  incremental: boolean;
  inputRequired: boolean;
  resume: boolean;
  cancel: boolean;
}): RuntimeMeasuredEvidence {
  return {
    agent_card: {
      protocol_version: "pass",
      transport: "pass",
      streaming_consistency: "pass",
    },
    basic_invocation: { status: "pass" },
    features: {
      streaming_transport: features.streaming ? "pass" : "not_applicable",
      incremental_content: features.incremental ? "pass" : "not_applicable",
      input_required: features.inputRequired ? "pass" : "not_applicable",
      resume: features.resume ? "pass" : "not_applicable",
      cancel: features.cancel ? "pass" : "not_applicable",
      durable_task_recovery: "not_measured",
    },
  };
}

/** HR 诚实声明：streaming/input_required/resume=true，cancel/durable=false。 */
function hrLikeInput(
  overrides: {
    measured?: RuntimeMeasuredEvidence;
    capabilities?: RuntimeCapabilitiesProjection;
    signer?: ActiveExternalConformanceBuilderInput["signer"];
  } = {},
): ActiveExternalConformanceBuilderInput {
  const declared = {
    streaming_transport: true,
    incremental_content: false,
    input_required: true,
    resume: true,
    cancel: false,
    durable_task_recovery: false,
  };
  const measured =
    overrides.measured ??
    measuredEvidenceFor({
      streaming: true,
      incremental: false,
      inputRequired: true,
      resume: true,
      cancel: false,
    });
  const capabilities: RuntimeCapabilitiesProjection = overrides.capabilities ?? {
    declared,
    measured,
    effective: {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
    },
  };
  return {
    runtimeRevisionId: "rev-hr-001",
    runtimeTargetDigest: `sha256:${"1".repeat(64)}`,
    runtimeConfigDigest: `sha256:${"2".repeat(64)}`,
    protocolContractRevision: "0.3.0",
    startedAt: "2026-08-27T01:00:00.000Z",
    completedAt: "2026-08-27T01:00:05.000Z",
    measured,
    capabilities,
    signer: overrides.signer ?? {
      keyId: "key-active-external-001",
      runnerIdentity: "ci/active-external-a2a-conformance",
      privateKeyPkcs8Base64: SIGNER_KEY.privateKeyPkcs8Base64,
    },
  };
}

function buildRegistryFor(report: RuntimeConformanceReport): RunnerSigningIdentityRegistry {
  return new Registry([
    {
      keyId: "key-active-external-001",
      publicKey: SIGNER_KEY.publicKeyBase64,
      runnerIdentity: report.runnerIdentity,
      tenantScope: TENANT_ID,
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: null,
      revokedAt: null,
    },
  ]);
}

function verifyEnvelope(
  report: RuntimeConformanceReport,
  dsseEnvelopeJson: string,
  expected: Partial<
    Pick<
      VerifyConformanceInput,
      | "expectedRuntimeRevisionId"
      | "expectedRuntimeTargetDigest"
      | "expectedRuntimeConfigDigest"
      | "expectedProtocolContractRevision"
    >
  > = {},
) {
  const verifier = createDSSEConformanceVerifier({
    runnerIdentityRegistry: buildRegistryFor(report),
  });
  return verifier.verify({
    dsseEnvelopeBytes: Buffer.from(dsseEnvelopeJson, "utf-8"),
    expectedRuntimeRevisionId: expected.expectedRuntimeRevisionId ?? report.runtimeRevisionId,
    expectedRuntimeTargetDigest: expected.expectedRuntimeTargetDigest ?? report.runtimeTargetDigest,
    expectedRuntimeConfigDigest: expected.expectedRuntimeConfigDigest ?? report.runtimeConfigDigest,
    expectedProtocolContractRevision:
      expected.expectedProtocolContractRevision ?? report.protocolContractRevision,
    tenantId: TENANT_ID,
  });
}

/** capability-consistency case 的冻结证据形态。 */
interface CapabilityConsistencyEvidence {
  caseId: string;
  passed: boolean;
  capability: {
    declared: boolean | null;
    measured: string | null;
    effective: boolean;
  };
}

function capabilityCase(
  report: RuntimeConformanceReport,
  caseId: (typeof PUBLICATION_CONFORMANCE_CASES)[number],
) {
  const result = report.caseResults.find((c) => c.caseId === caseId);
  expect(result, `缺少 case ${caseId}`).toBeDefined();
  return result!;
}

// ─── 测试 ─────────────────────────────────────────────────

describe("buildActiveExternalConformanceReport — HR 诚实声明 happy path", () => {
  it("产出精确六 case、全部通过、digest/manifest/suite revision 精确一致的 report", () => {
    const { report } = buildActiveExternalConformanceReport(hrLikeInput());

    expect(
      report.caseResults.map((c: RuntimeConformanceReport["caseResults"][number]) => c.caseId),
    ).toEqual([...PUBLICATION_CONFORMANCE_CASES]);
    expect(
      report.caseResults.every((c: RuntimeConformanceReport["caseResults"][number]) => c.passed),
    ).toBe(true);
    expect(report.overallResult).toBe("passed");
    expect(report.suiteRevision).toBe(PUBLICATION_CONFORMANCE_SUITE_REVISION);
    expect(report.runtimeRevisionId).toBe("rev-hr-001");
    expect(report.runtimeTargetDigest).toBe(`sha256:${"1".repeat(64)}`);
    expect(report.runtimeConfigDigest).toBe(`sha256:${"2".repeat(64)}`);
    expect(report.protocolContractRevision).toBe("0.3.0");
    expect(report.startedAt).toBe("2026-08-27T01:00:00.000Z");
    expect(report.completedAt).toBe("2026-08-27T01:00:05.000Z");
    expect(report.runId).toMatch(/^[0-9a-f-]{36}$/);

    for (const result of report.caseResults) {
      expect(result.evidence.caseId).toBe(result.caseId);
      expect(result.evidence.passed).toBe(result.passed);
      expect(Object.keys(result.evidence).length).toBeGreaterThan(2);
      expect(result.evidenceDigest).toBe(computeCaseEvidenceDigest(result.evidence));
    }
    expect(report.evidenceManifestDigest).toBe(
      computeEvidenceManifestDigest({
        suiteRevision: report.suiteRevision,
        testEnvironmentRevision: report.testEnvironmentRevision,
        runtimeRevisionId: report.runtimeRevisionId,
        runtimeTargetDigest: report.runtimeTargetDigest,
        runtimeConfigDigest: report.runtimeConfigDigest,
        protocolContractRevision: report.protocolContractRevision,
        runnerArtifactDigest: report.runnerArtifactDigest,
        cases: report.caseResults.map((c: RuntimeConformanceReport["caseResults"][number]) => ({
          caseId: c.caseId,
          passed: c.passed,
          evidenceDigest: c.evidenceDigest,
        })),
      }),
    );
    // domain 权威 validator 必须接受该 report。
    expect(() => validateRuntimeConformanceReport(report)).not.toThrow();
  });

  it("runner artifact / test environment 是确定性的生产常量（非随机占位）", () => {
    const a = buildActiveExternalConformanceReport(hrLikeInput());
    const b = buildActiveExternalConformanceReport(
      hrLikeInput({
        signer: {
          keyId: "key-other",
          runnerIdentity: "ci/active-external-a2a-conformance",
          privateKeyPkcs8Base64: generateEd25519SignerKeyPair().privateKeyPkcs8Base64,
        },
      }),
    );
    expect(a.report.runnerArtifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.report.runnerArtifactDigest).toBe(b.report.runnerArtifactDigest);
    expect(a.report.testEnvironmentRevision).toBe(b.report.testEnvironmentRevision);
    expect(a.report.testEnvironmentRevision).toMatch(/\S+/);
    expect(a.report.runnerArtifactDigest).not.toBe(`sha256:${"0".repeat(64)}`);
  });

  it("case 1 capability-manifest-contract 绑定真实 AgentCard 一致性与 declared/effective 布尔", () => {
    const input = hrLikeInput();
    const { report } = buildActiveExternalConformanceReport(input);
    const c = capabilityCase(report, "capability-manifest-contract");
    const evidence = c.evidence as {
      agentCard: unknown;
      declared: unknown;
      effective: unknown;
    };
    expect(evidence.agentCard).toEqual(input.measured.agent_card);
    expect(evidence.declared).toEqual(input.capabilities.declared);
    expect(evidence.effective).toEqual(input.capabilities.effective);
  });

  it("case 2 dispatch-acknowledgement 绑定 basic_invocation=pass 与真实流式测量", () => {
    const input = hrLikeInput();
    const { report } = buildActiveExternalConformanceReport(input);
    const c = capabilityCase(report, "dispatch-acknowledgement");
    const evidence = c.evidence as { basicInvocation: string; streaming: string };
    expect(evidence.basicInvocation).toBe("pass");
    expect(evidence.streaming).toBe("pass");
  });

  it("case 3 cancel=false：诚实不支持一致性（declared=false/not_applicable/effective=false），绝不宣称 ack", () => {
    const { report } = buildActiveExternalConformanceReport(hrLikeInput());
    const c = capabilityCase(report, "cancel-acknowledgement");
    expect(c.passed).toBe(true);
    const evidence = c.evidence as unknown as CapabilityConsistencyEvidence;
    expect(evidence.capability).toEqual({
      declared: false,
      measured: "not_applicable",
      effective: false,
    });
    // 不存在任何 ack 宣称。
    const serialized = JSON.stringify(c.evidence);
    expect(serialized).not.toContain("acknowledged");
    expect(serialized).not.toContain('"canceled"');
    expect(serialized).not.toContain("cancelAck");
  });

  it("case 4 steer：外部导入 A2A 合同显式 unsupported，无探针证据、无伪造 ack", () => {
    const { report } = buildActiveExternalConformanceReport(hrLikeInput());
    const c = capabilityCase(report, "steer-capability-consistency");
    expect(c.passed).toBe(true);
    const evidence = c.evidence as unknown as CapabilityConsistencyEvidence;
    expect(evidence.capability).toEqual({
      declared: false,
      measured: "not_applicable",
      effective: false,
    });
    expect(JSON.stringify(c.evidence)).not.toContain("acknowledged");
  });

  it("case 5 resume=true：measured=pass/effective=true 通过", () => {
    const { report } = buildActiveExternalConformanceReport(hrLikeInput());
    const c = capabilityCase(report, "resume-capability-consistency");
    expect(c.passed).toBe(true);
    const evidence = c.evidence as unknown as CapabilityConsistencyEvidence;
    expect(evidence.capability).toEqual({ declared: true, measured: "pass", effective: true });
  });

  it("case 6 session-recovery durable=false：诚实不支持通过", () => {
    const { report } = buildActiveExternalConformanceReport(hrLikeInput());
    const c = capabilityCase(report, "session-recovery-declaration");
    expect(c.passed).toBe(true);
    const evidence = c.evidence as unknown as CapabilityConsistencyEvidence;
    expect(evidence.capability).toEqual({
      declared: false,
      measured: "not_measured",
      effective: false,
    });
  });
});

describe("buildActiveExternalConformanceReport — DSSE envelope", () => {
  it("是 in-toto v1 标准 payloadType 的 Ed25519 签名 envelope，可被真实 verifier 验证", async () => {
    const input = hrLikeInput();
    const { report, dsseEnvelopeJson } = buildActiveExternalConformanceReport(input);

    const envelope = JSON.parse(dsseEnvelopeJson) as {
      payloadType: string;
      payload: string;
      signatures: Array<{ keyid: string; sig: string }>;
    };
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0]?.keyid).toBe(input.signer.keyId);
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf-8")) as {
      _type: string;
      predicateType: string;
      subject: Array<{ digest: { sha256: string } }>;
    };
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType).toBe(RUNTIME_CONFORMANCE_PREDICATE_TYPE);
    expect(statement.subject[0]?.digest.sha256).toBe(
      input.runtimeTargetDigest.replace("sha256:", ""),
    );

    const result = await verifyEnvelope(report, dsseEnvelopeJson);
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.claims.signingKeyId).toBe(input.signer.keyId);
      expect(result.claims.runnerIdentity).toBe(input.signer.runnerIdentity);
      expect(result.claims.report).toEqual(report);
    }
  });

  it("绑定校验：verifier 拒绝不匹配的 revision/target/config/protocol", async () => {
    const { report, dsseEnvelopeJson } = buildActiveExternalConformanceReport(hrLikeInput());
    expect(
      (await verifyEnvelope(report, dsseEnvelopeJson, { expectedRuntimeRevisionId: "rev-other" }))
        .verified,
    ).toBe(false);
    expect(
      (
        await verifyEnvelope(report, dsseEnvelopeJson, {
          expectedRuntimeTargetDigest: `sha256:${"9".repeat(64)}`,
        })
      ).verified,
    ).toBe(false);
    expect(
      (
        await verifyEnvelope(report, dsseEnvelopeJson, {
          expectedRuntimeConfigDigest: `sha256:${"8".repeat(64)}`,
        })
      ).verified,
    ).toBe(false);
    expect(
      (
        await verifyEnvelope(report, dsseEnvelopeJson, {
          expectedProtocolContractRevision: "0.4.0",
        })
      ).verified,
    ).toBe(false);
  });

  it("密钥边界：PKCS8 私钥 base64 不出现在 report/envelope JSON 中", () => {
    const { report, dsseEnvelopeJson } = buildActiveExternalConformanceReport(hrLikeInput());
    expect(JSON.stringify(report)).not.toContain(SIGNER_KEY.privateKeyPkcs8Base64);
    expect(dsseEnvelopeJson).not.toContain(SIGNER_KEY.privateKeyPkcs8Base64);
  });
});

describe("buildActiveExternalConformanceReport — fail closed", () => {
  it("05 专项 P2-3：durable 三态诚实矩阵（declared=true + not_measured + effective=false → PASS）", () => {
    const declared = {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: true,
    };
    const measured = measuredEvidenceFor({
      streaming: true,
      incremental: false,
      inputRequired: true,
      resume: true,
      cancel: false,
    });
    const effective = {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
    };
    // true/not_measured/false → pass（声明未验证 → 平台不承诺，Registration 仍可过）
    const passReport = buildActiveExternalConformanceReport(
      hrLikeInput({ measured, capabilities: { declared, measured, effective } }),
    );
    const passCase = capabilityCase(passReport.report, "session-recovery-declaration");
    expect(passCase.passed).toBe(true);

    // true/pass/false → fail（平台无 durable 正式 Probe，measured=pass 属伪造）
    const forgedMeasured = {
      ...measured,
      features: {
        ...measured.features,
        // 伪造：平台无 durable 正式 Probe 却声称 measured=pass（类型层用 as 表达反例）
        durable_task_recovery: "pass",
      },
    } as unknown as RuntimeMeasuredEvidence;
    const forgedReport = buildActiveExternalConformanceReport(
      hrLikeInput({
        measured: forgedMeasured,
        capabilities: { declared, measured: forgedMeasured, effective },
      }),
    );
    expect(capabilityCase(forgedReport.report, "session-recovery-declaration").passed).toBe(false);

    // true/not_measured/true → fail（effective=true 但 measured!=pass，三态矛盾）
    const contradictionReport = buildActiveExternalConformanceReport(
      hrLikeInput({
        measured,
        capabilities: {
          declared,
          measured,
          effective: { ...effective, durable_task_recovery: true },
        },
      }),
    );
    expect(capabilityCase(contradictionReport.report, "session-recovery-declaration").passed).toBe(
      false,
    );
  });

  it("cancel=true 但 measured 非 pass：cancel case 失败且 overall=failed", () => {
    const declared = {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: true,
      durable_task_recovery: false,
    };
    const measured = measuredEvidenceFor({
      streaming: true,
      incremental: false,
      inputRequired: true,
      resume: true,
      // 声明 cancel=true 但未测得 pass —— 一致性失败。
      cancel: false,
    });
    const input = hrLikeInput({
      measured,
      capabilities: {
        declared,
        measured,
        effective: {
          streaming_transport: true,
          incremental_content: false,
          input_required: true,
          resume: true,
          cancel: false,
          durable_task_recovery: false,
        },
      },
    });
    const { report } = buildActiveExternalConformanceReport(input);
    expect(capabilityCase(report, "cancel-acknowledgement").passed).toBe(false);
    expect(report.overallResult).toBe("failed");
  });

  it("resume=true 但 effective=false：resume case 失败", () => {
    const declared = {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
    };
    const measured = measuredEvidenceFor({
      streaming: true,
      incremental: false,
      inputRequired: true,
      resume: true,
      cancel: false,
    });
    const input = hrLikeInput({
      measured,
      capabilities: {
        declared,
        measured,
        effective: {
          streaming_transport: true,
          incremental_content: false,
          input_required: true,
          resume: false,
          cancel: false,
          durable_task_recovery: false,
        },
      },
    });
    const { report } = buildActiveExternalConformanceReport(input);
    expect(capabilityCase(report, "resume-capability-consistency").passed).toBe(false);
    expect(report.overallResult).toBe("failed");
  });

  it("resume=false：仅 not_applicable/effective=false 诚实通过", () => {
    const declared = {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: false,
      cancel: false,
      durable_task_recovery: false,
    };
    const measured = measuredEvidenceFor({
      streaming: true,
      incremental: false,
      inputRequired: true,
      resume: false,
      cancel: false,
    });
    const input = hrLikeInput({
      measured,
      capabilities: {
        declared,
        measured,
        effective: {
          streaming_transport: true,
          incremental_content: false,
          input_required: true,
          resume: false,
          cancel: false,
          durable_task_recovery: false,
        },
      },
    });
    const { report } = buildActiveExternalConformanceReport(input);
    const c = capabilityCase(report, "resume-capability-consistency");
    expect(c.passed).toBe(true);
    const evidence = c.evidence as unknown as CapabilityConsistencyEvidence;
    expect(evidence.capability).toEqual({
      declared: false,
      measured: "not_applicable",
      effective: false,
    });
  });

  it("measured 与 capabilities.measured 重复事实不一致：fail closed，不返回 envelope", () => {
    const declared = {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
    };
    const measured = measuredEvidenceFor({
      streaming: true,
      incremental: false,
      inputRequired: true,
      resume: true,
      cancel: false,
    });
    // 顶层 measured 与 capabilities.measured 是同一事实的重复表达；
    // 不一致时禁止签名出报告。
    const tamperedMeasured: RuntimeMeasuredEvidence = {
      ...measured,
      features: { ...measured.features, resume: "not_applicable" },
    };
    const input = hrLikeInput({
      measured,
      capabilities: {
        declared,
        measured: tamperedMeasured,
        effective: {
          streaming_transport: true,
          incremental_content: false,
          input_required: true,
          resume: true,
          cancel: false,
          durable_task_recovery: false,
        },
      },
    });
    expect(() => buildActiveExternalConformanceReport(input)).toThrow();
  });

  it("completedAt 早于 startedAt：fail closed，不返回 envelope", () => {
    const input = hrLikeInput();
    expect(() =>
      buildActiveExternalConformanceReport({
        ...input,
        startedAt: "2026-08-27T01:00:05.000Z",
        completedAt: "2026-08-27T01:00:00.000Z",
      }),
    ).toThrow();
  });

  it("signer 私钥缺失/为空/非法 base64/非 Ed25519：fail closed，不返回 envelope", () => {
    const base = hrLikeInput();
    expect(() =>
      buildActiveExternalConformanceReport(
        hrLikeInput({ signer: { ...base.signer, privateKeyPkcs8Base64: "" } }),
      ),
    ).toThrow();
    expect(() =>
      buildActiveExternalConformanceReport({
        ...base,
        signer: { ...base.signer, privateKeyPkcs8Base64: "!!!not-base64!!!" },
      }),
    ).toThrow();
    expect(() =>
      buildActiveExternalConformanceReport({
        ...base,
        signer: { ...base.signer, privateKeyPkcs8Base64: generateRsaPkcs8PrivateKeyBase64() },
      }),
    ).toThrow();
    expect(() =>
      buildActiveExternalConformanceReport({
        ...base,
        signer: { ...base.signer, keyId: "" },
      }),
    ).toThrow();
    expect(() =>
      buildActiveExternalConformanceReport({
        ...base,
        signer: { ...base.signer, runnerIdentity: "" },
      }),
    ).toThrow();
    // 缺失 signer 字段（运行时省略）也必须 fail closed。
    expect(() =>
      buildActiveExternalConformanceReport({ ...base, signer: undefined as never }),
    ).toThrow();
  });

  it("签名密钥与 Ed25519 无关时：即使返回 envelope 也无法通过真实 verifier", async () => {
    // 防御性：用与注册表不匹配的另一对密钥签名，verifier 必须拒签。
    const otherKey = generateKeyPairSync("ed25519");
    const pkcs8 = otherKey.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
    const input = hrLikeInput({
      signer: {
        keyId: "key-active-external-001",
        runnerIdentity: "ci/active-external-a2a-conformance",
        privateKeyPkcs8Base64: pkcs8.toString("base64"),
      },
    });
    const { report, dsseEnvelopeJson } = buildActiveExternalConformanceReport(input);
    const result = await verifyEnvelope(report, dsseEnvelopeJson);
    expect(result.verified).toBe(false);
  });
});

describe("buildActiveExternalConformanceReport — manifest 三态一致性 fail closed", () => {
  /** 按 override 构造 capabilities 投影（measured 与顶层保持一致）。 */
  function inputWithProjection(params: {
    declared: RuntimeCapabilitiesProjection["declared"];
    measured: RuntimeMeasuredEvidence;
    effective: RuntimeCapabilitiesProjection["effective"];
  }): ActiveExternalConformanceBuilderInput {
    return hrLikeInput({
      measured: params.measured,
      capabilities: {
        declared: params.declared,
        measured: params.measured,
        effective: params.effective,
      },
    });
  }

  it("input_required declared=true/measured=pass/effective=false：manifest 失败且 overall=failed", () => {
    const declared = {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
    };
    const measured = measuredEvidenceFor({
      streaming: true,
      incremental: false,
      inputRequired: true,
      resume: true,
      cancel: false,
    });
    const input = inputWithProjection({
      declared,
      measured,
      effective: {
        streaming_transport: true,
        incremental_content: false,
        // 矛盾：声明且测得 pass，但 effective=false。
        input_required: false,
        resume: true,
        cancel: false,
        durable_task_recovery: false,
      },
    });
    const { report } = buildActiveExternalConformanceReport(input);
    expect(capabilityCase(report, "capability-manifest-contract").passed).toBe(false);
    expect(report.overallResult).toBe("failed");
  });

  it("incremental declared=false/measured=not_applicable/effective=true：manifest 失败且 overall=failed", () => {
    const declared = {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
    };
    const measured = measuredEvidenceFor({
      streaming: true,
      incremental: false,
      inputRequired: true,
      resume: true,
      cancel: false,
    });
    const input = inputWithProjection({
      declared,
      measured,
      effective: {
        streaming_transport: true,
        // 矛盾：未声明也未测，但 effective=true。
        incremental_content: true,
        input_required: true,
        resume: true,
        cancel: false,
        durable_task_recovery: false,
      },
    });
    const { report } = buildActiveExternalConformanceReport(input);
    expect(capabilityCase(report, "capability-manifest-contract").passed).toBe(false);
    expect(report.overallResult).toBe("failed");
  });

  it("streaming declared=false/measured=pass/effective=true：manifest 失败且 overall=failed", () => {
    const declared = {
      streaming_transport: false,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
    };
    // 矛盾：未声明流式，却测得 pass 且 effective=true。
    const measured = measuredEvidenceFor({
      streaming: true,
      incremental: false,
      inputRequired: true,
      resume: true,
      cancel: false,
    });
    const input = inputWithProjection({
      declared,
      measured,
      effective: {
        streaming_transport: true,
        incremental_content: false,
        input_required: true,
        resume: true,
        cancel: false,
        durable_task_recovery: false,
      },
    });
    const { report } = buildActiveExternalConformanceReport(input);
    expect(capabilityCase(report, "capability-manifest-contract").passed).toBe(false);
    expect(report.overallResult).toBe("failed");
  });

  it("incremental=true 而 streaming=false：即使各自三态内部自洽，manifest 也必须失败", () => {
    // 各自三态均内部自洽：streaming=false/not_applicable/effective=false；
    // incremental=true/pass/effective=true。但 incremental 依赖流式传输。
    const declared = {
      streaming_transport: false,
      incremental_content: true,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
    };
    const measured = measuredEvidenceFor({
      streaming: false,
      incremental: true,
      inputRequired: true,
      resume: true,
      cancel: false,
    });
    const input = inputWithProjection({
      declared,
      measured,
      effective: {
        streaming_transport: false,
        incremental_content: true,
        input_required: true,
        resume: true,
        cancel: false,
        durable_task_recovery: false,
      },
    });
    const { report } = buildActiveExternalConformanceReport(input);
    expect(capabilityCase(report, "capability-manifest-contract").passed).toBe(false);
    expect(report.overallResult).toBe("failed");
  });
});
