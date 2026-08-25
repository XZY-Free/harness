/**
 * 测试支撑：为 AgentRevision 绑定一个不可变 AgentDescriptorSnapshot（Batch 2 权威外部合同）。
 *
 * 生产发布链是：descriptors 路由登记 Snapshot → create-revision 路由绑定 → publish 路由发布。
 * 测试装配 helper 无法走完整 HTTP，但发布命令（Batch 2 起）强制 Revision 精确绑定 Snapshot。
 * 本 helper 幂等地：若 revision 已绑定则直接回读其证据；否则为该 Agent 生成一个规范 Snapshot
 * 并绑定到 revision，供测试通过正式发布命令或 store 级装配走发布。
 *
 * 事实源：docs/V12/01/agent补充/01 §2 / 02 §5。
 */
import { randomUUID } from "node:crypto";
import {
  type ProviderAgentCard,
  canonicalizeAgentDescriptor,
} from "@/lib/agents/domain/agent-descriptor";
import type { AgentPublicationDescriptorSnapshot } from "@/lib/agents/persistence/agent-publication-store";
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentDescriptorStore } from "@/lib/agents/persistence/mysql-agent-descriptor-store";
import { db } from "@/lib/db/client";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { eq } from "drizzle-orm";

/** 测试 Agent 的最小有效外部合同（能力只描述"会什么任务"，不携带函数签名）。 */
const TEST_AGENT_CARD: ProviderAgentCard = {
  protocol: { type: "a2a", contractRevision: "1.0" },
  identity: { name: "test-agent", providerRevisionRef: "test-provider-v1" },
  capabilities: [
    {
      capabilityKey: "event_stream",
      name: "事件流",
      description: "处理事件流任务",
      tags: ["events"],
      inputModes: ["text"],
      outputModes: ["text"],
    },
  ],
  invocationContext: [{ contextKind: "conversation_history", necessity: "accepted" }],
};

/**
 * 为给定 Revision 幂等地绑定一个 AgentDescriptorSnapshot，返回其发布证据。
 * revision 已绑定 → 回读；否则生成并绑定新 Snapshot。
 */
export async function ensureAgentDescriptorSnapshotBoundForRevision(
  revisionId: string,
  tenantId: string,
): Promise<AgentPublicationDescriptorSnapshot> {
  const revision = await getRevisionById(revisionId);
  if (!revision) {
    throw new Error(`测试 AgentRevision 不存在: ${revisionId}`);
  }

  // 已绑定：直接回读（Snapshot 不可变，binding 不可换）。
  if (revision.agentDescriptorSnapshotId) {
    const existing = await mysqlAgentDescriptorStore.transaction((s) =>
      s.findSnapshotById(revision.agentDescriptorSnapshotId as string),
    );
    if (existing) {
      return {
        id: existing.id,
        agentId: existing.agentId,
        providerDescriptorDigest: existing.providerDescriptorDigest,
        capabilityManifestDigest: existing.capabilityManifestDigest,
        invocationContextContractDigest: existing.invocationContextContractDigest,
      };
    }
  }

  const canonicalized = canonicalizeAgentDescriptor({
    tenantId,
    agentId: revision.agentId,
    descriptorKind: "agent_card",
    card: TEST_AGENT_CARD,
  });
  const snapshotId = randomUUID();
  await mysqlAgentDescriptorStore.transaction((s) =>
    s.insertSnapshot({
      id: snapshotId,
      tenantId,
      agentId: revision.agentId,
      descriptorKind: "agent_card",
      protocolType: "a2a",
      protocolContractRevision: "1.0",
      canonicalProviderDescriptor: canonicalized.canonicalProviderDescriptor,
      providerDescriptorDigest: canonicalized.providerDescriptorDigest,
      normalizedCapabilityManifest: canonicalized.normalizedCapabilityManifest,
      capabilityManifestDigest: canonicalized.capabilityManifestDigest,
      invocationContextContract: canonicalized.invocationContextContract,
      invocationContextContractDigest: canonicalized.invocationContextContractDigest,
      providerDeclaredRevisionRef: "test-provider-v1",
      contractSectionProvenance: canonicalized.contractSectionProvenance,
      capturedAt: new Date(),
      createdBy: "test-support",
    }),
  );
  await db
    .update(agentRevisionTable)
    .set({ agentDescriptorSnapshotId: snapshotId })
    .where(eq(agentRevisionTable.id, revisionId));

  return {
    id: snapshotId,
    agentId: revision.agentId,
    providerDescriptorDigest: canonicalized.providerDescriptorDigest,
    capabilityManifestDigest: canonicalized.capabilityManifestDigest,
    invocationContextContractDigest: canonicalized.invocationContextContractDigest,
  };
}
