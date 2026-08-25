import { randomUUID } from "node:crypto";
import {
  AgentDescriptorError,
  type OperatorContextSupplement,
  type ProviderAgentCard,
  canonicalizeAgentDescriptor,
} from "@/lib/agents/domain/agent-descriptor";
import type {
  AgentDescriptorStore,
  AgentDescriptorStoreSession,
} from "@/lib/agents/persistence/agent-descriptor-store";

export interface CreateAgentDescriptorSnapshotResult {
  snapshotId: string;
  providerDescriptorDigest: string;
  capabilityManifestDigest: string;
  invocationContextContractDigest: string;
  descriptorKind: string;
  protocolType: string;
  protocolContractRevision: string;
  capturedAt: Date;
}

export interface CreateAgentDescriptorSnapshotCommand {
  tenantId: string;
  agentId: string;
  descriptorKind: string;
  /** Provider 正式公开的 Agent Card（外部合同）。 */
  card: ProviderAgentCard;
  /** 管理员基于第三方正式接入合同登记的 supplemental context（operator_declared）。 */
  operatorContextSupplement?: OperatorContextSupplement | undefined;
  /** provider 声明的原始修订标识（可选，仅参考，不作 Authority）。 */
  providerDeclaredRevisionRef?: string | null;
  createdBy: string;
  /** 内部测试注入用。 */
  now?: Date;
}

export class AgentDescriptorAgentNotFoundError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly agentId: string,
  ) {
    super(`Agent ${agentId} 不存在或不属于租户 ${tenantId}`);
    this.name = "AgentDescriptorAgentNotFoundError";
  }
}

/**
 * createAgentDescriptorSnapshot：登记外部 Agent 的外部合同，形成不可变 AgentDescriptorSnapshot。
 *
 * 这是"不读 Agent 源码"的登记入口：只接受 Provider 公开的 Agent Card（外部合同）与可选 operator
 * supplement，规范化为结构化 CapabilityManifest + InvocationContextContract 并计算稳定 digest。
 * 任何能力/上下文/协议变化都必须生成新 Snapshot（→ 新 AgentRevision），不覆盖已发布 Snapshot。
 */
export function createCreateAgentDescriptorSnapshot(dependencies: {
  store: AgentDescriptorStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function createAgentDescriptorSnapshot(
    command: CreateAgentDescriptorSnapshotCommand,
  ): Promise<CreateAgentDescriptorSnapshotResult> {
    if (!command.createdBy || !command.createdBy.trim()) {
      throw new AgentDescriptorError("createdBy 不能为空");
    }
    const capturedAt = command.now ?? now();

    // 规范化（含 CapabilityManifest / InvocationContextContract 校验与 digest）
    const canonicalized = canonicalizeAgentDescriptor({
      tenantId: command.tenantId,
      agentId: command.agentId,
      descriptorKind: command.descriptorKind,
      card: command.card,
      operatorContextSupplement: command.operatorContextSupplement,
    });

    const snapshotId = newId();
    const protocolType = command.card.protocol.type;
    const protocolContractRevision = command.card.protocol.contractRevision;

    await dependencies.store.transaction(async (session: AgentDescriptorStoreSession) => {
      const agent = await session.findAgent(command.tenantId, command.agentId);
      if (!agent) {
        throw new AgentDescriptorAgentNotFoundError(command.tenantId, command.agentId);
      }
      await session.insertSnapshot({
        id: snapshotId,
        tenantId: command.tenantId,
        agentId: command.agentId,
        descriptorKind: command.descriptorKind,
        protocolType,
        protocolContractRevision,
        canonicalProviderDescriptor: canonicalized.canonicalProviderDescriptor,
        providerDescriptorDigest: canonicalized.providerDescriptorDigest,
        normalizedCapabilityManifest: canonicalized.normalizedCapabilityManifest,
        capabilityManifestDigest: canonicalized.capabilityManifestDigest,
        invocationContextContract: canonicalized.invocationContextContract,
        invocationContextContractDigest: canonicalized.invocationContextContractDigest,
        providerDeclaredRevisionRef: command.providerDeclaredRevisionRef ?? null,
        contractSectionProvenance: canonicalized.contractSectionProvenance,
        capturedAt,
        createdBy: command.createdBy,
      });
    });

    return {
      snapshotId,
      providerDescriptorDigest: canonicalized.providerDescriptorDigest,
      capabilityManifestDigest: canonicalized.capabilityManifestDigest,
      invocationContextContractDigest: canonicalized.invocationContextContractDigest,
      descriptorKind: command.descriptorKind,
      protocolType,
      protocolContractRevision,
      capturedAt,
    };
  };
}
