import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { getAttestationById } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import { db } from "@/lib/db/client";
import { agentRevisionTable } from "@/lib/persistence/schema/agent";
import { eq } from "drizzle-orm";

/** 真实 MySQL 测试装配：绑定权威 Artifact 后通过正式应用服务发布 AgentRevision。 */
export async function publishTrustedAgentRevisionForTest(params: {
  tenantId: string;
  revisionId: string;
  agentExpectedVersionNo: number;
  attestationId: string;
  actorId: string;
}) {
  const attestation = await getAttestationById(params.tenantId, params.attestationId);
  if (!attestation?.artifactId || attestation.verificationState !== "verified") {
    throw new Error(`测试 AgentRevision 缺少权威 Attestation: ${params.revisionId}`);
  }
  await db
    .update(agentRevisionTable)
    .set({ artifactId: attestation.artifactId, artifactDigest: attestation.artifactDigest })
    .where(eq(agentRevisionTable.id, params.revisionId));

  return createPublishAgentRevision({ store: mysqlAgentPublicationStore })({
    tenantId: params.tenantId,
    revisionId: params.revisionId,
    agentExpectedVersionNo: params.agentExpectedVersionNo,
    attestationId: params.attestationId,
    actor: { tenantId: params.tenantId, actorType: "service", actorId: params.actorId },
    requestId: `test-publish-agent:${params.revisionId}`,
    idempotencyKey: `test-publish-agent:${params.revisionId}`,
  });
}
