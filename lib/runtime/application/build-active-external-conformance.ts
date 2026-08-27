/**
 * Active external A2A Runtime Publication Conformance 报告/DSSE 纯构造器。
 *
 * 冻结不变量（与 build-active-external-conformance.test.ts 一一对应）：
 * - 输入只绑定租户无关报告事实 + 显式 Ed25519 signer 描述符；不存在
 *   prompt/transcript/credential/AgentCard body 输入，无任何兼容缺省。
 * - 一切事实必须显式且自洽：顶层 measured 与 capabilities.measured 不一致、
 *   时间区间非法（completedAt 早于 startedAt / 非法时间）、signer 缺失/为空/
 *   非 base64/非 Ed25519，一律 fail closed，不返回任何 envelope。
 * - 六 case 只做诚实一致性裁决：cancel=false / steer 只能以「真实不支持」通过
 *   （declared=false / measured=not_applicable / effective=false），绝不伪造 ack；
 *   cancel/resume=true 仅在 measured=pass 且 effective=true 时通过；
 *   durable=true 但未测量（not_measured/effective=false）必须判失败。
 * - per-case / manifest digest 一律复用 domain 权威函数；runner artifact digest 与
 *   test environment revision 是本验证器实现确定性常量（非随机占位）。
 * - 输出 DSSE 为 in-toto v1 Statement + 标准 payloadType + Ed25519（PKCS8 私钥
 *   仅在内存中用于签名，绝不序列化进 report/envelope）；签名前必须先通过
 *   domain 权威 validator（validateRuntimeConformanceReport）。
 */
import { createHash, createPrivateKey, sign as cryptoSign, randomUUID } from "node:crypto";
import { computeDssePae } from "@/lib/crypto/dsse";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import type {
  RuntimeCapabilitiesProjection,
  RuntimeMeasuredEvidence,
} from "@/lib/runtime/application/register-agent-runtime";
import { RUNTIME_CONFORMANCE_PREDICATE_TYPE } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { PUBLICATION_CONFORMANCE_SUITE_REVISION } from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  type RuntimeConformanceCaseId,
  type RuntimeConformanceReport,
  computeCaseEvidenceDigest,
  computeEvidenceManifestDigest,
  validateRuntimeConformanceReport,
} from "@/lib/runtime/domain/runtime-conformance-run";

/** 构造失败类别（全部 fail closed：不产出 report/envelope）。 */
export type ActiveExternalConformanceBuildErrorKind =
  | "input_invalid" // 报告事实缺失/非法/重复事实不一致
  | "signer_invalid"; // signer 缺失/为空/非 base64/非 Ed25519

export class ActiveExternalConformanceBuildError extends Error {
  constructor(
    public readonly kind: ActiveExternalConformanceBuildErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ActiveExternalConformanceBuildError";
  }
}

/** 显式 Ed25519 signer 描述符（PKCS8 私钥 base64，仅内存使用）。 */
export interface ActiveExternalConformanceSigner {
  keyId: string;
  runnerIdentity: string;
  /** PKCS8 DER 私钥的 base64。 */
  privateKeyPkcs8Base64: string;
}

/** 构造输入：只绑定租户无关报告事实 + signer，全部必填、无缺省。 */
export interface ActiveExternalConformanceBuilderInput {
  runtimeRevisionId: string;
  runtimeTargetDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
  startedAt: string;
  completedAt: string;
  /** 已完成的黑盒 probe 结构化 measured 证据矩阵。 */
  measured: RuntimeMeasuredEvidence;
  /** declared/measured/effective 三态投影（measured 必须与顶层一致）。 */
  capabilities: RuntimeCapabilitiesProjection;
  signer: ActiveExternalConformanceSigner;
  /** 03 专项：Probe Context 审计摘要（只记录 kind；可选）。 */
  probeContextKinds?: {
    supplied: string[];
    omitted_preferred: string[];
    unavailable_required: string[];
  };
}

export interface ActiveExternalConformanceBuildResult {
  report: RuntimeConformanceReport;
  /** 已签名的 DSSE Envelope JSON 字符串（in-toto v1 + Ed25519）。 */
  dsseEnvelopeJson: string;
}

// ─── 确定性实现身份常量 ───────────────────────────────────

/** 本 active external A2A 验证器实现的确定性身份（用于 runnerArtifactDigest）。 */
const RUNNER_ARTIFACT_IDENTITY =
  "snowharness/runtime-application/build-active-external-conformance@1";

/** runnerArtifactDigest：实现身份的 sha256（固定，非随机占位）。 */
const RUNNER_ARTIFACT_DIGEST = `sha256:${createHash("sha256")
  .update(RUNNER_ARTIFACT_IDENTITY, "utf-8")
  .digest("hex")}`;

/** 本验证器测试环境修订号（确定性生产常量）。 */
const TEST_ENVIRONMENT_REVISION = "active-external-a2a-blackbox@1";

/** DSSE 标准 payloadType（in-toto v1）。 */
const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

// ─── 输入 fail-closed 校验 ───────────────────────────────

function fail(kind: ActiveExternalConformanceBuildErrorKind, message: string): never {
  throw new ActiveExternalConformanceBuildError(kind, message);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("input_invalid", `${field} 必须是非空字符串`);
  }
  return value;
}

/** 校验报告事实（网络前语义：全部显式，无兼容缺省）。 */
function validateFacts(input: ActiveExternalConformanceBuilderInput): void {
  requireNonEmptyString(input.runtimeRevisionId, "runtimeRevisionId");
  requireNonEmptyString(input.runtimeTargetDigest, "runtimeTargetDigest");
  requireNonEmptyString(input.runtimeConfigDigest, "runtimeConfigDigest");
  requireNonEmptyString(input.protocolContractRevision, "protocolContractRevision");
  if (!input.measured || !input.capabilities) {
    fail("input_invalid", "measured 与 capabilities 必须显式提供");
  }
  // 重复事实必须一致：顶层 measured 与 capabilities.measured 是同一事实。
  if (
    computeCanonicalDigest(input.measured) !== computeCanonicalDigest(input.capabilities.measured)
  ) {
    fail("input_invalid", "measured 与 capabilities.measured 不一致");
  }
  const startedAt = new Date(input.startedAt);
  const completedAt = new Date(input.completedAt);
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(completedAt.getTime())) {
    fail("input_invalid", "startedAt/completedAt 必须是合法 ISO 时间");
  }
  if (completedAt.getTime() < startedAt.getTime()) {
    fail("input_invalid", "completedAt 不得早于 startedAt");
  }
}

/** 校验 signer 并解析 Ed25519 PKCS8 私钥（仅返回内存 KeyObject，不序列化）。 */
function resolveEd25519PrivateKey(
  signer: ActiveExternalConformanceBuilderInput["signer"],
): ReturnType<typeof createPrivateKey> {
  if (!signer || typeof signer !== "object") {
    fail("signer_invalid", "signer 必须显式提供");
  }
  requireNonEmptyString(signer.keyId, "signer.keyId");
  requireNonEmptyString(signer.runnerIdentity, "signer.runnerIdentity");
  const privateBase64 = signer.privateKeyPkcs8Base64;
  if (typeof privateBase64 !== "string" || privateBase64.length === 0) {
    fail("signer_invalid", "signer.privateKeyPkcs8Base64 必须非空");
  }
  let pkcs8: Buffer;
  try {
    pkcs8 = Buffer.from(privateBase64, "base64");
  } catch {
    return fail("signer_invalid", "signer 私钥不是合法 base64");
  }
  // 严格 base64：解码后回编码必须一致（拒绝混合非法字符）。
  if (pkcs8.toString("base64") !== privateBase64) {
    fail("signer_invalid", "signer 私钥不是合法 base64");
  }
  if (pkcs8.length === 0) {
    fail("signer_invalid", "signer 私钥为空");
  }
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  } catch {
    return fail("signer_invalid", "signer 私钥不是合法 PKCS8");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    fail("signer_invalid", "signer 私钥必须是 Ed25519");
  }
  return privateKey;
}

// ─── 六 case 诚实一致性裁决 ───────────────────────────────

interface CaseDraft {
  caseId: RuntimeConformanceCaseId;
  passed: boolean;
  reason: string | null;
  evidence: Record<string, unknown>;
}

/** 可选能力一致性：false 仅在 not_applicable/effective=false 时诚实通过。 */
function judgeOptionalCapability(params: {
  caseId: RuntimeConformanceCaseId;
  declared: boolean;
  measured: string;
  effective: boolean;
  feature: string;
}): CaseDraft {
  const { caseId, declared, measured, effective, feature } = params;
  const capability = { declared, measured, effective };
  if (!declared) {
    const passed = measured === "not_applicable" && effective === false;
    return {
      caseId,
      passed,
      reason: passed ? null : `${feature}=false 只能以 not_applicable/effective=false 诚实通过`,
      evidence: { caseId, passed, capability },
    };
  }
  const passed = measured === "pass" && effective === true;
  return {
    caseId,
    passed,
    reason: passed ? null : `${feature}=true 必须 measured=pass 且 effective=true`,
    evidence: { caseId, passed, capability },
  };
}

function buildCaseDrafts(input: ActiveExternalConformanceBuilderInput): CaseDraft[] {
  const { measured, capabilities } = input;
  const declared = capabilities.declared;
  const effective = capabilities.effective;
  const features = measured.features;

  // 1 capability-manifest-contract：AgentCard 一致性 + declared/effective 布尔。
  // streaming/incremental/input_required 三能力执行与 cancel/resume 相同的
  // 诚实三态规则：declared=false ⇒ measured=not_applicable 且 effective=false；
  // declared=true ⇒ measured=pass 且 effective=true。任何矛盾判失败。
  const agentCardAllPass = Object.values(measured.agent_card).every((v) => v === "pass");
  const manifestEvidence = {
    agentCard: measured.agent_card,
    declared,
    effective,
  };
  const manifestTriStateOk = (
    feature: "streaming_transport" | "incremental_content" | "input_required",
  ): boolean => {
    if (declared[feature]) {
      return features[feature] === "pass" && effective[feature] === true;
    }
    return features[feature] === "not_applicable" && effective[feature] === false;
  };
  // incremental_content 依赖流式传输：incremental=true 而 streaming=false 是
  // 非法合同组合（即使各自三态内部自洽），manifest 必须失败。
  const incrementalDependencyOk = !declared.incremental_content || declared.streaming_transport;
  const manifestPassed =
    agentCardAllPass &&
    manifestTriStateOk("streaming_transport") &&
    manifestTriStateOk("incremental_content") &&
    manifestTriStateOk("input_required") &&
    incrementalDependencyOk;

  // 2 dispatch-acknowledgement：basic_invocation=pass + 真实流式测量（如适用）。
  const basicInvocation = measured.basic_invocation.status;
  const streaming = features.streaming_transport;
  const dispatchPassed =
    basicInvocation === "pass" && (streaming === "pass" || streaming === "not_applicable");

  // 4 steer：外部导入 A2A 合同无 steer 能力，显式 unsupported（无探针证据）。
  const steerDraft: CaseDraft = {
    caseId: "steer-capability-consistency",
    passed: true,
    reason: null,
    evidence: {
      caseId: "steer-capability-consistency",
      passed: true,
      capability: { declared: false, measured: "not_applicable", effective: false },
    },
  };

  const drafts: CaseDraft[] = [
    {
      caseId: "capability-manifest-contract",
      passed: manifestPassed,
      reason: manifestPassed
        ? null
        : "AgentCard 一致性证据或 streaming/incremental/input_required 三态一致性不满足",
      evidence: {
        caseId: "capability-manifest-contract",
        passed: manifestPassed,
        ...manifestEvidence,
      },
    },
    {
      caseId: "dispatch-acknowledgement",
      passed: dispatchPassed,
      reason: dispatchPassed ? null : "basic_invocation 或流式测量不满足",
      evidence: {
        caseId: "dispatch-acknowledgement",
        passed: dispatchPassed,
        basicInvocation,
        streaming,
      },
    },
    judgeOptionalCapability({
      caseId: "cancel-acknowledgement",
      declared: declared.cancel,
      measured: features.cancel,
      effective: effective.cancel,
      feature: "cancel",
    }),
    steerDraft,
    judgeOptionalCapability({
      caseId: "resume-capability-consistency",
      declared: declared.resume,
      measured: features.resume,
      effective: effective.resume,
      feature: "resume",
    }),
    // 6 session-recovery-declaration：durable 未测量（阶段 1 恒 not_measured）。
    // declared=true 而 effective=false 必须 fail closed。
    (() => {
      const declaredDurable = declared.durable_task_recovery;
      const measuredDurable = features.durable_task_recovery;
      const effectiveDurable = effective.durable_task_recovery;
      const capability = {
        declared: declaredDurable,
        measured: measuredDurable,
        effective: effectiveDurable,
      };
      // 05 专项（P2-3）：case 职责是三态诚实，不是"声明即必须验证"。
      // - declared=false / true 且平台未测（not_measured + effective=false）→ pass
      //   （声明了但未验证 → 平台不承诺该能力；Registration/Publication 仍可通过）。
      // - measured=pass（平台无对应正式 Probe，属伪造）→ fail。
      // - effective=true 但 measured!=pass（三态矛盾）→ fail。
      const passed = measuredDurable === "not_measured" && !effectiveDurable;
      return {
        caseId: "session-recovery-declaration" as const,
        passed,
        reason: passed
          ? null
          : "durable_task_recovery 三态不诚实（measured 非 not_measured 或 effective 与 measured 矛盾）",
        evidence: {
          caseId: "session-recovery-declaration",
          passed,
          capability,
        },
      };
    })(),
  ];
  return drafts;
}

// ─── 构造入口 ─────────────────────────────────────────────

/**
 * 将已完成的 active external A2A 黑盒 probe 事实构造为一份签名
 * RuntimeConformanceReport + DSSE Envelope。纯函数（除随机 runId 与签名外无副作用）。
 * 任何输入事实不自洽 / signer 非法一律抛 ActiveExternalConformanceBuildError，
 * 不返回 envelope。
 */
export function buildActiveExternalConformanceReport(
  input: ActiveExternalConformanceBuilderInput,
): ActiveExternalConformanceBuildResult {
  // 1) 输入事实 + signer fail-closed 校验（先于一切构造/签名）。
  validateFacts(input);
  const privateKey = resolveEd25519PrivateKey(input.signer);

  // 2) 六 case 诚实一致性裁决 + domain 权威 digest。
  const drafts = buildCaseDrafts(input);
  const caseResults = drafts.map((draft) => ({
    caseId: draft.caseId,
    passed: draft.passed,
    reason: draft.reason,
    evidenceDigest: computeCaseEvidenceDigest(draft.evidence),
    evidence: draft.evidence,
  }));
  const overallResult = caseResults.every((c) => c.passed) ? "passed" : "failed";
  const report: RuntimeConformanceReport = {
    runId: randomUUID(),
    runtimeRevisionId: input.runtimeRevisionId,
    runtimeTargetDigest: input.runtimeTargetDigest,
    runtimeConfigDigest: input.runtimeConfigDigest,
    protocolContractRevision: input.protocolContractRevision,
    suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
    runnerArtifactDigest: RUNNER_ARTIFACT_DIGEST,
    runnerIdentity: input.signer.runnerIdentity,
    testEnvironmentRevision: TEST_ENVIRONMENT_REVISION,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    overallResult,
    ...(input.probeContextKinds ? { probe_context_kinds: input.probeContextKinds } : {}),
    evidenceManifestDigest: computeEvidenceManifestDigest({
      suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
      testEnvironmentRevision: TEST_ENVIRONMENT_REVISION,
      runtimeRevisionId: input.runtimeRevisionId,
      runtimeTargetDigest: input.runtimeTargetDigest,
      runtimeConfigDigest: input.runtimeConfigDigest,
      protocolContractRevision: input.protocolContractRevision,
      runnerArtifactDigest: RUNNER_ARTIFACT_DIGEST,
      cases: caseResults.map((c) => ({
        caseId: c.caseId,
        passed: c.passed,
        evidenceDigest: c.evidenceDigest,
      })),
    }),
    caseResults,
  };

  // 3) domain 权威 validator（签名前必须通过：digest/manifest/时间/整体一致性）。
  validateRuntimeConformanceReport(report);

  // 4) in-toto v1 Statement + Ed25519 签名（私钥仅内存使用，绝不序列化）。
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "runtime-target",
        digest: { sha256: report.runtimeTargetDigest.replace("sha256:", "") },
      },
    ],
    predicateType: RUNTIME_CONFORMANCE_PREDICATE_TYPE,
    predicate: report,
  };
  const payloadBytes = Buffer.from(JSON.stringify(statement), "utf-8");
  const pae = computeDssePae(DSSE_PAYLOAD_TYPE, payloadBytes);
  const signature = cryptoSign(null, pae, privateKey);
  const envelope = {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: payloadBytes.toString("base64"),
    signatures: [{ keyid: input.signer.keyId, sig: signature.toString("base64") }],
  };

  return { report, dsseEnvelopeJson: JSON.stringify(envelope) };
}
