import { issueWorkloadToken } from "@/lib/identity/workload-token";

/** Tests must construct the same authority-bound credential as production callers. */
export function issueTestExecutionToken(input: {
  tenantId: string;
  invocationId: string;
  audience: "runtime" | "gateway";
  runtimeRevisionId?: string;
  attemptId?: string;
  ownershipId?: string;
  leaseEpoch?: string;
  sessionBindingId?: string;
}): string {
  return issueWorkloadToken({
    contractVersion: 3,
    type: "execution",
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    runtimeRevisionId: input.runtimeRevisionId ?? input.invocationId,
    attemptId: input.attemptId ?? input.invocationId,
    ownershipId: input.ownershipId ?? input.invocationId,
    leaseEpoch: input.leaseEpoch ?? "1",
    sessionBindingId: input.sessionBindingId ?? input.invocationId,
    audience: input.audience,
    expiresAt: Date.now() + 300_000,
  });
}
