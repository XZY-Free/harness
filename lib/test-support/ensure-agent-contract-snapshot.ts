/**
 * 测试支撑：为 AgentRevision 绑定一个不可变 AgentContractSnapshot（发布权威外部合同）。
 *
 * 生产发布链是：agent-registrations 登记结构化合同快照 → create-revision 路由绑定 →
 * publish 路由发布。测试装配 helper 无法走完整 HTTP，但发布命令强制 Revision 精确绑定
 * 同 tenant/Agent 的 AgentContractSnapshot。
 * 本 helper 幂等地：若 revision 已绑定则直接回读其证据；否则为该 Agent 登记一个
 * 结构化合同快照并绑定到 revision，供测试通过正式发布命令走发布。
 */
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import type { AgentPublicationContractSnapshot } from "@/lib/agents/persistence/agent-publication-store";
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { db } from "@/lib/db/client";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { eq } from "drizzle-orm";

/**
 * 为给定 Revision 幂等地绑定一个 AgentContractSnapshot，返回其发布证据。
 * revision 已绑定 → 回读；否则生成并绑定新快照。
 */
export async function ensureAgentContractSnapshotBoundForRevision(
  revisionId: string,
  tenantId: string,
): Promise<AgentPublicationContractSnapshot> {
  const revision = await getRevisionById(revisionId);
  if (!revision) {
    throw new Error(`测试 AgentRevision 不存在: ${revisionId}`);
  }

  // 已绑定：直接回读（Snapshot 不可变，binding 不可换）。
  if (revision.agentContractSnapshotId) {
    const existing = await mysqlAgentContractStore.transaction((session) =>
      session.findContractSnapshotById(tenantId, revision.agentContractSnapshotId as string),
    );
    if (existing) {
      return {
        id: existing.id,
        agentId: existing.agentId,
        contractDigest: existing.contractDigest,
        capabilityDigest: existing.capabilityDigest,
        contextDigest: existing.contextDigest,
        recomputedContractDigest: existing.contractDigest,
        recomputedCapabilityDigest: existing.capabilityDigest,
        recomputedContextDigest: existing.contextDigest,
      };
    }
  }

  const snapshot = await seedAgentContractSnapshot({
    tenantId,
    agentId: revision.agentId,
    createdBy: "test-support",
  });
  await db
    .update(agentRevisionTable)
    .set({ agentContractSnapshotId: snapshot.id })
    .where(eq(agentRevisionTable.id, revisionId));

  return {
    id: snapshot.id,
    agentId: snapshot.agentId,
    contractDigest: snapshot.contractDigest,
    capabilityDigest: snapshot.capabilityDigest,
    contextDigest: snapshot.contextDigest,
    recomputedContractDigest: snapshot.contractDigest,
    recomputedCapabilityDigest: snapshot.capabilityDigest,
    recomputedContextDigest: snapshot.contextDigest,
  };
}
