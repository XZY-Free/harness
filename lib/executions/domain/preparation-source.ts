import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";

export const EXECUTION_SOURCE_KINDS = [
  "initial",
  "handoff",
  "user_resume",
  "continuation",
  "redispatch",
] as const;

export type ExecutionSourceKind = (typeof EXECUTION_SOURCE_KINDS)[number];

export interface ExecutionSourcePredecessor {
  attemptId: string;
  ownershipId: string;
  leaseEpoch: string;
  sessionBindingId: string;
}

export type ExecutionSourceRecovery =
  | { kind: "initial" }
  | {
      kind: "resume";
      anchor: string;
      anchorDigest: string;
      checkpointId: string | null;
    };

/**
 * 某一已持久来源对准备/激活的不可变要求。
 * predecessor 由接纳事务从当时持久 O/S 事实填入，调用方不能自报。
 */
export interface ExecutionSourceRequest {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  sourceOperationKey: string;
  intentType: "start" | "resume";
  sourceKind: ExecutionSourceKind;
  sourceRef: string;
  runtimeRevisionId: string;
  workspaceBindingId: string;
  environmentDefinitionRevisionId: string | null;
  bindingConfigDigest: string;
  inputDigest: string;
  recovery: ExecutionSourceRecovery;
}

export interface ExecutionSourceSnapshot extends ExecutionSourceRequest {
  predecessor: ExecutionSourcePredecessor | null;
}

export function executionSourceDigest(source: ExecutionSourceSnapshot): string {
  return computeCanonicalDigest(source);
}

export function executionSourceRequestOf(source: ExecutionSourceSnapshot): ExecutionSourceRequest {
  const { predecessor: _predecessor, ...request } = source;
  return request;
}

export function sameExecutionSourceRequest(
  left: ExecutionSourceRequest,
  right: ExecutionSourceRequest,
): boolean {
  return computeCanonicalDigest(left) === computeCanonicalDigest(right);
}

export function assertExecutionSourceSnapshot(value: unknown): ExecutionSourceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ExecutionSourceSnapshotInvalid");
  }
  const source = value as Record<string, unknown>;
  const requiredStrings = [
    "tenantId",
    "invocationId",
    "attemptId",
    "sourceOperationKey",
    "sourceRef",
    "runtimeRevisionId",
    "workspaceBindingId",
    "bindingConfigDigest",
    "inputDigest",
  ] as const;
  if (requiredStrings.some((key) => typeof source[key] !== "string" || source[key] === "")) {
    throw new Error("ExecutionSourceSnapshotInvalid");
  }
  if (
    !source.sourceKind ||
    !EXECUTION_SOURCE_KINDS.includes(source.sourceKind as ExecutionSourceKind)
  ) {
    throw new Error("ExecutionSourceSnapshotInvalid");
  }
  if (source.intentType !== "start" && source.intentType !== "resume") {
    throw new Error("ExecutionSourceSnapshotInvalid");
  }
  if (
    source.environmentDefinitionRevisionId !== null &&
    typeof source.environmentDefinitionRevisionId !== "string"
  ) {
    throw new Error("ExecutionSourceSnapshotInvalid");
  }
  const recovery = source.recovery as Record<string, unknown> | null;
  if (!recovery || (recovery.kind !== "initial" && recovery.kind !== "resume")) {
    throw new Error("ExecutionSourceSnapshotInvalid");
  }
  if (
    recovery.kind === "resume" &&
    (typeof recovery.anchor !== "string" ||
      typeof recovery.anchorDigest !== "string" ||
      (recovery.checkpointId !== null && typeof recovery.checkpointId !== "string"))
  ) {
    throw new Error("ExecutionSourceSnapshotInvalid");
  }
  const predecessor = source.predecessor as Record<string, unknown> | null;
  if (
    predecessor !== null &&
    (!predecessor ||
      ["attemptId", "ownershipId", "leaseEpoch", "sessionBindingId"].some(
        (key) => typeof predecessor[key] !== "string" || predecessor[key] === "",
      ))
  ) {
    throw new Error("ExecutionSourceSnapshotInvalid");
  }
  return value as ExecutionSourceSnapshot;
}
