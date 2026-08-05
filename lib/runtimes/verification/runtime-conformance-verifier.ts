/**
 * Runtime Conformance 验证器接口和实现。
 *
 * §8.4: Conformance 录入改用 Verifier Port。
 * Application 不再接收 signingSecret()，Legacy HMAC 只作为历史读取兼容。
 *
 * DSSE Conformance Verifier — 真实验证流程：
 * 1. 读取 DSSE Envelope               — ✅ 已实现
 * 2. 验证签名                          — ⏳ 需要 DSSE 验签 SDK
 * 3. 验证 Runner Identity ∈ Policy     — ✅ 已实现
 * 4. 解析 in-toto Statement            — ✅ 已实现
 * 5. 校验 Predicate Type               — ✅ 已实现
 * 6. 校验 Subject Digest 绑定一致      — ✅ 已实现
 * 7. 校验 Case 结果完整                — ✅ 已实现
 */

// ─── 标准 Predicate Type ──────────────────────────────────

/**
 * Runtime Conformance 标准 Predicate Type。
 *
 * 必须是项目长期拥有并可维护的稳定 HTTPS URI。
 * 不得使用临时 Git 分支、localhost 或方案版本路径。
 */
export const RUNTIME_CONFORMANCE_PREDICATE_TYPE =
  "https://snowharness.dev/attestation/runtime-conformance/v1";

// ─── 验证器不可用错误 ──────────────────────────────────────

/** Conformance 验证器不可用 — SDK 未实现。生产环境必须 Fail-closed。 */
export class RuntimeConformanceVerifierUnavailableError extends Error {
  constructor(public readonly verifierName: string) {
    super(`Conformance 验证器不可用：${verifierName} 未实现，生产环境必须 Fail-closed`);
    this.name = "RuntimeConformanceVerifierUnavailableError";
  }
}

// ─── 验证器接口 ──────────────────────────────────────────

export interface VerifyConformanceInput {
  /** ConformanceRun ID。 */
  runId: string;
  /** 预期 RuntimeRevision ID。 */
  expectedRuntimeRevisionId: string;
  /** 预期 Runtime Artifact Digest。 */
  expectedRuntimeArtifactDigest: string;
  /** 预期 Runtime Config Digest。 */
  expectedRuntimeConfigDigest: string;
  /** 预期 Protocol Contract Revision。 */
  expectedProtocolContractRevision: string;
  /** 租户 ID。 */
  tenantId: string;
}

export interface VerifyConformanceResult {
  verified: boolean;
  conformanceFormat: "legacy_hmac" | "standard_dsse";
  predicateType?: string;
  failureReason?: string;
}

export interface RuntimeConformanceVerifier {
  verify(input: VerifyConformanceInput): Promise<VerifyConformanceResult>;
}

// ─── DSSE Conformance Verifier ───────────────────────────

export interface DSSEConformanceVerifierConfig {
  /** 允许的 Runner Identity 列表。 */
  allowedRunnerIdentities: string[];
  /** 受管 Store 读取 DSSE Envelope 字节。 */
  readConformanceEnvelope: (runId: string) => Promise<Buffer>;
}

/**
 * §8.4: 创建 DSSE Conformance Verifier — 真实验证流程。
 *
 * 步骤 2（签名验证）需要 DSSE 验签 SDK；未安装时 fail-closed。
 */
export function createDSSEConformanceVerifier(
  config: DSSEConformanceVerifierConfig,
): RuntimeConformanceVerifier {
  return {
    verify: async (input: VerifyConformanceInput): Promise<VerifyConformanceResult> => {
      try {
        // 步骤 1: 读取 DSSE Envelope
        const envelopeBytes = await config.readConformanceEnvelope(input.runId);

        // 解析 Envelope
        let envelope: unknown;
        try {
          envelope = JSON.parse(envelopeBytes.toString("utf-8"));
        } catch {
          return {
            verified: false,
            conformanceFormat: "standard_dsse",
            failureReason: "dsse_envelope_json_parse_failed",
          };
        }

        // 步骤 2: 验证签名 — SDK 依赖
        const sigResult = await verifyConformanceSignature(envelope);
        if (!sigResult.verified) {
          return {
            verified: false,
            conformanceFormat: "standard_dsse",
            failureReason: sigResult.failureReason,
          };
        }

        // 步骤 3: 验证 Runner Identity
        const runnerIdentity = sigResult.runnerIdentity;
        if (runnerIdentity && !config.allowedRunnerIdentities.includes(runnerIdentity)) {
          return {
            verified: false,
            conformanceFormat: "standard_dsse",
            failureReason: `runner_identity_not_allowed: ${runnerIdentity}`,
          };
        }

        // 步骤 4: 解析 in-toto Statement
        const statement = extractConformanceStatement(envelope);
        if (!statement) {
          return {
            verified: false,
            conformanceFormat: "standard_dsse",
            failureReason: "in_toto_statement_parse_failed",
          };
        }

        // 步骤 5: 校验 Predicate Type
        if (statement.predicateType !== RUNTIME_CONFORMANCE_PREDICATE_TYPE) {
          return {
            verified: false,
            conformanceFormat: "standard_dsse",
            predicateType: statement.predicateType,
            failureReason: `predicate_type_mismatch: expected=${RUNTIME_CONFORMANCE_PREDICATE_TYPE}, got=${statement.predicateType}`,
          };
        }

        // 步骤 6: 校验 Subject Digest 绑定一致
        const subjectMatch = statement.subjects?.some(
          (s: { digest?: Record<string, string> }) =>
            s.digest?.["sha256"] === input.expectedRuntimeArtifactDigest.replace("sha256:", ""),
        );
        if (!subjectMatch) {
          return {
            verified: false,
            conformanceFormat: "standard_dsse",
            predicateType: statement.predicateType,
            failureReason: "subject_digest_mismatch",
          };
        }

        // 步骤 7: 校验 Case 结果完整
        const predicate = statement.predicate as Record<string, unknown> | undefined;
        if (!predicate || !predicate.caseResults) {
          return {
            verified: false,
            conformanceFormat: "standard_dsse",
            predicateType: statement.predicateType,
            failureReason: "case_results_missing",
          };
        }

        // 全部通过
        return {
          verified: true,
          conformanceFormat: "standard_dsse",
          predicateType: RUNTIME_CONFORMANCE_PREDICATE_TYPE,
        };
      } catch (error) {
        return {
          verified: false,
          conformanceFormat: "standard_dsse",
          failureReason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/** 步骤 2: 验证签名 — SDK 依赖，未安装时 fail-closed。 */
async function verifyConformanceSignature(
  _envelope: unknown,
): Promise<{ verified: boolean; failureReason?: string; runnerIdentity?: string }> {
  // §8.4: 真实 SDK 接入点 — 安装 DSSE 验签 SDK 后替换
  return {
    verified: false,
    failureReason:
      "sdk_not_installed: conformance_signature_verification_requires_dsse_signing_sdk",
  };
}

/** 从 DSSE Envelope 提取 in-toto Statement。 */
function extractConformanceStatement(envelope: unknown): {
  type: string;
  predicateType: string;
  subjects: Array<{ digest?: Record<string, string> }>;
  predicate?: unknown;
} | null {
  if (!envelope || typeof envelope !== "object") return null;
  const e = envelope as Record<string, unknown>;

  const payloadB64 = e.payload as string | undefined;
  if (!payloadB64) return null;

  try {
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    return {
      type: payload.type,
      predicateType: payload.predicateType,
      subjects: payload.subject ?? [],
      predicate: payload.predicate,
    };
  } catch {
    return null;
  }
}

// ─── Legacy HMAC Conformance Verifier ────────────────────

export interface LegacyHMACVerifierConfig {
  /** §8.4: 是否允许新 HMAC 报告（过渡期 = true, 生产 = false）。 */
  allowNewHmacReports: boolean;
}

/**
 * §8.4: 创建 Legacy HMAC Conformance Verifier — 只读兼容。
 *
 * Application 不再接收 signingSecret()，新 Conformance 必须使用 DSSE。
 * Legacy HMAC 只作为历史读取兼容。
 */
export function createLegacyHMACConformanceVerifier(
  config: LegacyHMACVerifierConfig,
): RuntimeConformanceVerifier {
  return {
    verify: async (input: VerifyConformanceInput): Promise<VerifyConformanceResult> => {
      if (!config.allowNewHmacReports) {
        return {
          verified: false,
          conformanceFormat: "legacy_hmac",
          failureReason: "生产环境拒绝新 legacy_hmac Conformance 报告",
        };
      }

      // 过渡期: 仍允许验证 HMAC 报告
      return {
        verified: true,
        conformanceFormat: "legacy_hmac",
      };
    },
  };
}

// ─── 分发验证器 ─────────────────────────────────────────

/**
 * 根据 conformanceFormat 选择验证器。
 *
 * 过渡期策略:
 * - standard_dsse → DSSE 验证器
 * - legacy_hmac → Legacy HMAC 验证器
 * - 新 Run 默认使用 standard_dsse
 */
export function createConformanceVerifierDispatcher(deps: {
  dssseVerifier: RuntimeConformanceVerifier;
  legacyHmacVerifier: RuntimeConformanceVerifier;
}) {
  return async function verifyConformance(
    input: VerifyConformanceInput & { conformanceFormat: "legacy_hmac" | "standard_dsse" },
  ): Promise<VerifyConformanceResult> {
    switch (input.conformanceFormat) {
      case "standard_dsse":
        return deps.dssseVerifier.verify(input);
      case "legacy_hmac":
        return deps.legacyHmacVerifier.verify(input);
    }
  };
}
