import { createHash } from "node:crypto";

export const PUBLICATION_SUBJECT_TYPES = ["agent_revision", "runtime_revision"] as const;
export type PublicationSubjectType = (typeof PUBLICATION_SUBJECT_TYPES)[number];

export const PUBLICATION_ACTOR_TYPES = ["user", "service", "workload", "system"] as const;
export type PublicationActorType = (typeof PUBLICATION_ACTOR_TYPES)[number];

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function computePublicationEvidenceSetDigest(params: {
  attestationIds: string[];
  conformanceRunId: string | null;
  approvals: unknown[];
  additionalEvidence?: unknown;
}): string {
  const evidence = canonicalize({
    approvals: params.approvals,
    attestation_ids: [...params.attestationIds].sort(),
    conformance_run_id: params.conformanceRunId,
    ...(params.additionalEvidence === undefined
      ? {}
      : { additional_evidence: params.additionalEvidence }),
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`;
}
