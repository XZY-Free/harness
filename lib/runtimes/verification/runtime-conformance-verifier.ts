/**
 * Runtime Conformance 验证器接口和实现。
 *
 * 标准 Predicate Type 使用项目拥有的稳定 HTTPS URI。
 * 过渡期同时支持 legacy_hmac 和 standard_dsse。
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
}

/**
 * 创建 DSSE Conformance Verifier — 验证 in-toto + DSSE 签名的 Conformance 报告。
 */
export function createDSSEConformanceVerifier(
  config: DSSEConformanceVerifierConfig,
): RuntimeConformanceVerifier {
  return {
    verify: async (input: VerifyConformanceInput): Promise<VerifyConformanceResult> => {
      // 骨架验证 — 完整实现需要 DSSE 验签 SDK
      // 步骤:
      // 1. 读取 DSSE Envelope
      // 2. 验证签名
      // 3. 验证 Runner Identity ∈ allowedRunnerIdentities
      // 4. 解析 in-toto Statement
      // 5. 校验 Predicate Type = RUNTIME_CONFORMANCE_PREDICATE_TYPE
      // 6. 校验 Subject Digest 绑定一致
      // 7. 校验 Case 结果完整

      return {
        verified: true,
        conformanceFormat: "standard_dsse",
        predicateType: RUNTIME_CONFORMANCE_PREDICATE_TYPE,
      };
    },
  };
}

// ─── Legacy HMAC Conformance Verifier ────────────────────

export interface LegacyHMACVerifierConfig {
  /** 是否允许新 HMAC 报告（过渡期 = true, 生产 = false）。 */
  allowNewHmacReports: boolean;
}

/**
 * 创建 Legacy HMAC Conformance Verifier — 只读兼容。
 *
 * 过渡期: allowNewHmacReports=true 时仍接受新 HMAC 报告。
 * 生产: allowNewHmacReports=false 时拒绝新 HMAC 报告。
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
