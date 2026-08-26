/**
 * 测试支撑：为 Agent 先登记结构化 AgentContractSnapshot，再创建绑定该 Snapshot 的
 * Draft Revision（黑盒语义 — Agent 发布权威是 Contract 证据，无源码 Artifact）。
 */
import { createDraftRevision } from "@/lib/agents/persistence/agent-revision-queries";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";

export async function createDraftRevisionWithContractSnapshot(
  params: Omit<Parameters<typeof createDraftRevision>[0], "agentContractSnapshotId">,
): Promise<ReturnType<typeof createDraftRevision>> {
  const snapshot = await seedAgentContractSnapshot({
    tenantId: params.tenantId,
    agentId: params.agentId,
    createdBy: params.createdBy,
  });
  return createDraftRevision({
    ...params,
    agentContractSnapshotId: snapshot.id,
  });
}
