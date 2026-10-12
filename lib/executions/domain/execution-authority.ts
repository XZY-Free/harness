import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";

export const OWNERSHIP_LEASE_MS = 90_000 as const;
export const OWNERSHIP_HEARTBEAT_MS = 20_000 as const;
export const OWNERSHIP_DISPATCH_DEADLINE_MS = 120_000 as const;

export type ExecutionAuthority = AuthorityIdentity;

export function preciseLeaseEpoch(value: string | number | bigint): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError("leaseEpoch 已超出 JavaScript 安全整数范围");
  }
  return BigInt(value);
}

export function authorityIdentity(input: {
  invocationId: string;
  runtimeRevisionId: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: string | number | bigint;
  sessionBindingId: string;
}): AuthorityIdentity {
  return {
    invocationId: input.invocationId,
    runtimeRevisionId: input.runtimeRevisionId,
    attemptId: input.attemptId,
    ownershipId: input.ownershipId,
    leaseEpoch: preciseLeaseEpoch(input.leaseEpoch).toString(),
    sessionBindingId: input.sessionBindingId,
  };
}

export function sameAuthority(a: AuthorityIdentity, b: AuthorityIdentity): boolean {
  return (
    a.invocationId === b.invocationId &&
    a.runtimeRevisionId === b.runtimeRevisionId &&
    a.attemptId === b.attemptId &&
    a.ownershipId === b.ownershipId &&
    a.leaseEpoch === b.leaseEpoch &&
    a.sessionBindingId === b.sessionBindingId
  );
}

export class ExecutionAuthorityError extends Error {
  constructor(
    public readonly code:
      | "NotCurrentExecutor"
      | "OwnershipExpired"
      | "HealthyOwnerExists"
      | "AttemptMismatch"
      | "RuntimeSessionMismatch"
      | "WorkspaceNotReady"
      | "CheckpointStale",
    message: string,
  ) {
    super(message);
    this.name = code;
  }
}
