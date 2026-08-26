import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { ensureAgentContractSnapshotBoundForRevision } from "@/lib/test-support/ensure-agent-contract-snapshot";

/** 真实 MySQL 测试装配：通过正式应用服务发布 AgentRevision（发布权威 = AgentContractSnapshot 证据）。 */
export async function publishTrustedAgentRevisionForTest(params: {
  tenantId: string;
  revisionId: string;
  agentExpectedVersionNo: number;
  actorId: string;
}) {
  // Agent 是源码不可见黑盒：发布权威是 AgentContractSnapshot，不再复核/传递 source Attestation。
  await ensureAgentContractSnapshotBoundForRevision(params.revisionId, params.tenantId);

  return createPublishAgentRevision({ store: mysqlAgentPublicationStore })({
    tenantId: params.tenantId,
    revisionId: params.revisionId,
    agentExpectedVersionNo: params.agentExpectedVersionNo,
    actor: { tenantId: params.tenantId, actorType: "service", actorId: params.actorId },
    requestId: `test-publish-agent:${params.revisionId}`,
    idempotencyKey: `test-publish-agent:${params.revisionId}`,
  });
}
