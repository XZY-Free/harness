/** Required RuntimeProtocol conformance contract shared by publication checks. */
import {
  CHECKPOINT_CAPABILITY_REQUIREMENTS,
  PROTOCOL_VERSION,
  type RuntimeCapabilities,
  RuntimeCapabilitiesSchema,
} from "@/lib/runtime/runtime-protocol";

/**
 * RuntimeProtocol 要求逐项验证的行为清单（Publication 套件的行为子集）。
 *
 * 事实源：docs/V12/02/snowharness-execution-design/sections/runtime-contract.md
 * §7.4—§7.10 与 docs/contracts/runtime-conformance.json 的 `required_cases`。
 *
 * 这些行为**不是声明**：发布/准入必须能追溯到该能力对应的实际调用回执。
 * 其中平台侧半边（Session 预登记、Ingress 幂等/冲突、Owner 续租与过期停机）由
 * Platform Integration Conformance（lib/platform-conformance）证明；本清单只约束
 * 候选 Runtime 自身在 Adapter 边界上可观察的那一半，两者职责分工但必须同时可追溯。
 */
export const RUNTIME_PROTOCOL_CONFORMANCE_CASES = [
  "heartbeat-semantics",
  "durable-start-idempotency",
  "started-event-before-ack",
  "exact-replay",
  "old-epoch-rejection",
  "workspace-profile",
  "filesystem-checkpoint",
] as const;
export type RuntimeProtocolConformanceCase = (typeof RUNTIME_PROTOCOL_CONFORMANCE_CASES)[number];

/** 判断某个 case id 是否属于 RuntimeProtocol 行为清单。 */
export function isRuntimeProtocolConformanceCase(
  value: string,
): value is RuntimeProtocolConformanceCase {
  return (RUNTIME_PROTOCOL_CONFORMANCE_CASES as readonly string[]).includes(value);
}

/**
 * 每个行为 case 必须携带的真实调用回执字段。
 *
 * 「只有 boolean evidence 的材料不接受」：`receipt` 必须是该 case 真实调用
 * RuntimeAdapter 得到的关键返回/失败事实（含被调用的方法名），而不是把
 * `passed` 再抄一遍。Validator 逐 case 校验这些键存在且不是布尔占位。
 */
export const RUNTIME_PROTOCOL_RECEIPT_KEYS: Record<RuntimeProtocolConformanceCase, string[]> = {
  "heartbeat-semantics": ["call", "acceptedAt", "capabilitiesDigest", "expectedCapabilitiesDigest"],
  "durable-start-idempotency": ["call", "retryDigestStable", "conflictDigestDiffers"],
  "started-event-before-ack": [
    "call",
    "transportAcceptanceOnly",
    "semanticRequestDigest",
    "retryDigestStable",
  ],
  "exact-replay": ["call", "semanticRequestDigest", "capabilitiesDigest"],
  "old-epoch-rejection": ["call", "outcome", "targetAuthorityEcho"],
  "workspace-profile": ["call", "declaredModes", "acceptedModes", "rejectedModes"],
  "filesystem-checkpoint": ["call", "declared", "declaredModes"],
};

/** 单个行为 case 的真实调用回执。 */
export interface RuntimeProtocolConformanceReceipt {
  caseId: RuntimeProtocolConformanceCase;
  passed: boolean;
  /** 真实调用回执；`call` 必须是实际调用的 RuntimeAdapter 方法名。 */
  receipt: Record<string, unknown>;
}

/** 行为证据自洽失败（缺 case、重复、回执缺键或为布尔占位）。 */
export class RuntimeProtocolConformanceEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeProtocolConformanceEvidenceError";
  }
}

/**
 * Validates the capabilities that a Runtime is allowed to publish. Behaviour
 * cases are supplied by the existing adapter conformance runner; declarations
 * alone never turn a failed case into a pass.
 */
export function validateRuntimeProtocolCapabilities(capabilities: RuntimeCapabilities): void {
  const parsed = RuntimeCapabilitiesSchema.safeParse(capabilities);
  if (!parsed.success) throw new Error(`RuntimeCapabilities 非法：${parsed.error.message}`);
  if (parsed.data.protocolVersion !== PROTOCOL_VERSION)
    throw new Error("RuntimeProtocol protocolVersion 不匹配");
  if (
    !parsed.data.features.subjectTypes.includes("thread") ||
    !parsed.data.features.subjectTypes.includes("job")
  ) {
    throw new Error("Runtime 必须同时声明 thread/job subject 能力");
  }
  if (
    new Set(parsed.data.features.workspaceModes).size !== parsed.data.features.workspaceModes.length
  ) {
    throw new Error("Runtime workspace profile 不得重复声明");
  }
  if (parsed.data.features.workspaceModes.includes("CHECKPOINT_RESTORABLE")) {
    const semantics = parsed.data.features.filesystemSemantics;
    if (
      semantics.kind !== "portable" ||
      semantics.specialFiles ||
      semantics.hardlinks ||
      !semantics.symlinks
    ) {
      throw new Error(
        `CHECKPOINT_RESTORABLE 必须声明受支持的 portable filesystem profile（${CHECKPOINT_CAPABILITY_REQUIREMENTS.join(", ")}）`,
      );
    }
  }
}

/**
 * 校验协议行为证据：全部行为 case 恰出现一次、全部通过，且逐 case 携带真实回执。
 *
 * 只写 `passed=true`、缺回执键、或把布尔值抄进回执一律拒绝（fail closed）。
 */
export function validateRuntimeProtocolConformanceEvidence(
  receipts: readonly RuntimeProtocolConformanceReceipt[],
): void {
  const byCase = new Map<RuntimeProtocolConformanceCase, RuntimeProtocolConformanceReceipt>();
  for (const entry of receipts) {
    if (!RUNTIME_PROTOCOL_CONFORMANCE_CASES.includes(entry.caseId)) {
      throw new RuntimeProtocolConformanceEvidenceError(
        `RuntimeProtocol Conformance 出现未声明 case：${entry.caseId}`,
      );
    }
    if (byCase.has(entry.caseId)) {
      throw new RuntimeProtocolConformanceEvidenceError(
        `RuntimeProtocol Conformance case 重复：${entry.caseId}`,
      );
    }
    byCase.set(entry.caseId, entry);
  }
  for (const caseId of RUNTIME_PROTOCOL_CONFORMANCE_CASES) {
    const entry = byCase.get(caseId);
    if (!entry) {
      throw new RuntimeProtocolConformanceEvidenceError(
        `RuntimeProtocol Conformance 缺少必需 case：${caseId}`,
      );
    }
    if (!entry.passed) {
      throw new RuntimeProtocolConformanceEvidenceError(
        `RuntimeProtocol Conformance case 未通过：${caseId}`,
      );
    }
    const receipt = entry.receipt;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new RuntimeProtocolConformanceEvidenceError(`${caseId} 缺少真实调用回执`);
    }
    if (typeof receipt.call !== "string" || receipt.call.trim().length === 0) {
      throw new RuntimeProtocolConformanceEvidenceError(
        `${caseId} 回执必须记录被调用的 Adapter 方法（receipt.call）`,
      );
    }
    for (const key of RUNTIME_PROTOCOL_RECEIPT_KEYS[caseId]) {
      const value = receipt[key];
      if (value === undefined || value === null) {
        throw new RuntimeProtocolConformanceEvidenceError(`${caseId} 回执缺少 ${key}`);
      }
    }
  }
}
