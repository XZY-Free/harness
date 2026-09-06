import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";

export interface ConfirmationProposalIdentityInput {
  agentCallId: string;
  taskId: string;
  contextId: string;
  proposalId: string;
}

export interface ConfirmationProposalSemanticInput {
  proposal_id: string;
  action_key: string;
  title: string;
  summary: string;
  impact: string;
  preview: Record<string, unknown>;
}

/**
 * Stable business identity for one external confirmation proposal.
 * Transport event ids are intentionally excluded: the same proposal can be
 * delivered by more than one input-required event without creating another
 * user decision.
 */
export function buildConfirmationActionId(input: ConfirmationProposalIdentityInput): string {
  const digest = computeCanonicalDigest({
    version: 1,
    agent_call_id: input.agentCallId,
    task_id: input.taskId,
    context_id: input.contextId,
    proposal_id: input.proposalId,
  }).slice("sha256:".length, "sha256:".length + 32);
  return `a2a-confirm:v1:${digest}`;
}

/** Semantic digest excludes transport metadata and expiry. */
export function computeConfirmationProposalSemanticDigest(
  proposal: ConfirmationProposalSemanticInput,
): string {
  return computeCanonicalDigest({
    proposal_id: proposal.proposal_id,
    action_key: proposal.action_key,
    title: proposal.title,
    summary: proposal.summary,
    impact: proposal.impact,
    preview: proposal.preview,
  });
}
