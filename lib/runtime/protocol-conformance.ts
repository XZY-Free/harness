/** Required RuntimeProtocol conformance contract shared by publication checks. */
import {
  CHECKPOINT_CAPABILITY_REQUIREMENTS,
  PROTOCOL_VERSION,
  type RuntimeCapabilities,
  RuntimeCapabilitiesSchema,
} from "@/lib/runtime/runtime-protocol";

export const RUNTIME_PROTOCOL_CONFORMANCE_CASES = [
  "heartbeat-semantics",
  "durable-start-idempotency",
  "exact-replay",
  "old-epoch-rejection",
  "workspace-profile",
  "filesystem-checkpoint",
] as const;
export type RuntimeProtocolConformanceCase = (typeof RUNTIME_PROTOCOL_CONFORMANCE_CASES)[number];

export interface RuntimeProtocolConformanceEvidence {
  protocolVersion: number;
  heartbeat: boolean;
  durableStartIdempotency: boolean;
  exactReplay: boolean;
  oldEpochRejection: boolean;
  workspaceProfile: boolean;
  filesystemCheckpoint: boolean;
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

export function validateRuntimeProtocolConformanceEvidence(
  evidence: RuntimeProtocolConformanceEvidence,
): void {
  const required: Array<keyof RuntimeProtocolConformanceEvidence> = [
    "heartbeat",
    "durableStartIdempotency",
    "exactReplay",
    "oldEpochRejection",
    "workspaceProfile",
    "filesystemCheckpoint",
  ];
  if (
    evidence.protocolVersion !== PROTOCOL_VERSION ||
    required.some((key) => evidence[key] !== true)
  ) {
    throw new Error("RuntimeProtocol Conformance evidence 不完整或未通过");
  }
}
