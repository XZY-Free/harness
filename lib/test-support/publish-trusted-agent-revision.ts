import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { getAttestationById } from "@/lib/artifacts/persistence/artifact-attestation-reader";

/** 真实 MySQL 测试装配：复核正式 Attestation 命令已原子绑定 Artifact 后，通过正式应用服务发布 AgentRevision。 */
export async function publishTrustedAgentRevisionForTest(params: {
  tenantId: string;
  revisionId: string;
  agentExpectedVersionNo: number;
  attestationId: string;
  actorId: string;
}) {
  const found = await getAttestationById(params.tenantId, params.attestationId);
  const attestation = found?.attestation;
  if (!attestation?.artifactId || attestation.verificationState !== "verified") {
    throw new Error(`测试 AgentRevision 缺少权威 Attestation: ${params.revisionId}`);
  }
  // 不直接写 DB 绑定 Artifact——正式 record-artifact-attestation command（verifyAndPersistAttestation）
  // 已在 verified 时通过 mysql store 原子 bindRevisionArtifact。此处仅用正式查询复核并 fail-closed，
  // 禁止在 helper 内直接写正式数据库结论或兼容兜底。
  const boundRevision = await getRevisionById(params.revisionId);
  if (
    !boundRevision ||
    boundRevision.artifactId !== attestation.artifactId ||
    boundRevision.artifactDigest !== attestation.artifactDigest
  ) {
    throw new Error(
      `正式 Attestation 命令未原子绑定 Artifact 到 AgentRevision（${params.revisionId}）：` +
        `期望 artifactId=${attestation.artifactId} artifactDigest=${attestation.artifactDigest}`,
    );
  }

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
