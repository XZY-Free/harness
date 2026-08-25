/**
 * registerAgentContract 应用命令：登记 Public Agent Contract，形成不可变结构化快照。
 *
 * 这是"合同文件是 request-only 输入"的登记入口：管理员提供 agent-contract.json（解析为
 * 结构化事实）与显式 protocol（合同文件不含 protocol，禁止硬编码），单事务写入
 * AgentContractSnapshot header + 有序 capability/context 子记录；任何子行失败整体回滚。
 * 同一合同再次显式登记生成新快照修订，绝不更新旧快照。
 *
 * 事实源：Public Agent Contract 冻结目标模型（本切片）。
 */
import { randomUUID } from "node:crypto";
import {
  PublicAgentContractError,
  type PublicAgentContractFacts,
  parsePublicAgentContract,
} from "@/lib/agents/domain/public-agent-contract";
import type {
  AgentContractStore,
  AgentContractStoreSession,
} from "@/lib/agents/persistence/agent-contract-store";
import type {
  NewAgentContractCapabilityRow,
  NewAgentContractInvocationContextRow,
  NewAgentContractSnapshot,
} from "@/lib/persistence/schema/agents";

export interface RegisterAgentContractCommand {
  tenantId: string;
  agentId: string;
  /** 协议事实：合同文件不含 protocol，由登记命令显式提供。 */
  protocol: {
    type: string;
    contractRevision: string;
  };
  /** 管理员提供的 agent-contract.json（request-only 输入，不整体持久化）。 */
  contract: unknown;
  createdBy: string;
  /** 内部测试注入用。 */
  now?: Date;
}

export interface RegisterAgentContractResult {
  snapshotId: string;
  contractDigest: string;
  capabilityDigest: string;
  contextDigest: string;
  publicAgentId: string;
  capturedAt: Date;
}

export class AgentContractAgentNotFoundError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly agentId: string,
  ) {
    super(`Agent ${agentId} 不存在或不属于租户 ${tenantId}`);
    this.name = "AgentContractAgentNotFoundError";
  }
}

export class AgentContractIdentityMismatchError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly agentKey: string,
    public readonly publicAgentId: string,
  ) {
    super(
      `合同 agent.id "${publicAgentId}" 与目标 Agent.agentKey "${agentKey}" 不一致（Agent ${agentId}）`,
    );
    this.name = "AgentContractIdentityMismatchError";
  }
}

/** 协议事实校验（合同文件不含 protocol，不默认、不硬编码）。供登记类命令复用。 */
export function validateRegistrationProtocol(protocol: {
  type: string;
  contractRevision: string;
}): void {
  if (!protocol || typeof protocol !== "object") {
    throw new PublicAgentContractError("protocol 必须显式提供（type 与 contractRevision）");
  }
  if (typeof protocol.type !== "string" || protocol.type.trim() === "") {
    throw new PublicAgentContractError("protocol.type 必须是非空字符串");
  }
  if (typeof protocol.contractRevision !== "string" || protocol.contractRevision.trim() === "") {
    throw new PublicAgentContractError("protocol.contractRevision 必须是非空字符串");
  }
}

/** 登记命令的协议事实形态。 */
export interface RegistrationProtocolFacts {
  type: string;
  contractRevision: string;
}

/** 合同快照的完整持久化行（header + 有序子记录）。 */
export interface ContractSnapshotRows {
  header: NewAgentContractSnapshot;
  capabilities: NewAgentContractCapabilityRow[];
  contexts: NewAgentContractInvocationContextRow[];
}

/**
 * 把已解析的合同事实构建为快照持久化行（纯函数，无 IO）。
 * 供 registerAgentContract 与 agent-registrations 登记事务复用；子记录 id 由 newChildId 注入。
 */
export function buildContractSnapshotRows(params: {
  snapshotId: string;
  tenantId: string;
  agentId: string;
  protocol: RegistrationProtocolFacts;
  facts: PublicAgentContractFacts;
  capturedAt: Date;
  createdBy: string;
  newChildId: () => string;
}): ContractSnapshotRows {
  const { facts } = params;
  const snapshotId = params.snapshotId;
  const header: NewAgentContractSnapshot = {
    id: snapshotId,
    tenantId: params.tenantId,
    agentId: params.agentId,
    contractVersion: facts.contractVersion,
    publicAgentId: facts.agent.id,
    publicAgentVersion: facts.agent.version,
    agentNameZhCn: facts.agent.nameZhCn,
    agentNameEn: facts.agent.nameEn,
    protocolType: params.protocol.type,
    protocolContractRevision: params.protocol.contractRevision,
    streamingTransport: facts.interaction.streamingTransport,
    incrementalContent: facts.interaction.incrementalContent,
    inputRequired: facts.interaction.inputRequired,
    resume: facts.interaction.resume,
    cancel: facts.interaction.cancel,
    durableTaskRecovery: facts.interaction.durableTaskRecovery,
    supportedLocales: facts.interaction.supportedLocales,
    resultFields: facts.resultFields,
    errorCodes: facts.errorCodes,
    resultNotesZhCn: facts.resultNotesZhCn,
    resultNotesEn: facts.resultNotesEn,
    contractDigest: facts.contractDigest,
    capabilityDigest: facts.capabilityDigest,
    contextDigest: facts.contextDigest,
    capturedAt: params.capturedAt,
    createdBy: params.createdBy,
  };
  const capabilities: NewAgentContractCapabilityRow[] = facts.capabilities.map((c, position) => ({
    id: params.newChildId(),
    snapshotId,
    position,
    key: c.key,
    nameZhCn: c.nameZhCn,
    nameEn: c.nameEn,
    descriptionZhCn: c.descriptionZhCn,
    descriptionEn: c.descriptionEn,
    tags: c.tags,
    examples: c.examples,
    inputModes: c.inputModes,
    outputModes: c.outputModes,
  }));
  const contexts: NewAgentContractInvocationContextRow[] = facts.invocationContexts.map(
    (c, position) => ({
      id: params.newChildId(),
      snapshotId,
      position,
      key: c.key,
      nameZhCn: c.nameZhCn,
      nameEn: c.nameEn,
      descriptionZhCn: c.descriptionZhCn,
      descriptionEn: c.descriptionEn,
      necessity: c.necessity,
      appliesTo: c.appliesTo,
      trustRequirement: c.trustRequirement,
      // 登记侧系统 provenance：合同由 provider 供给
      declarationSource: "provider_declared",
    }),
  );
  return { header, capabilities, contexts };
}

export function createRegisterAgentContract(dependencies: {
  store: AgentContractStore;
  now?: () => Date;
  /** 快照 id 生成器；测试可单独冻结，不影响子记录主键。 */
  newId?: () => string;
  /** 子记录 id 生成器；与快照 id 分离，便于真实验证子行冲突回滚。 */
  newChildId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;
  const newChildId = dependencies.newChildId ?? randomUUID;

  return async function registerAgentContract(
    command: RegisterAgentContractCommand,
  ): Promise<RegisterAgentContractResult> {
    if (!command.createdBy || command.createdBy.trim() === "") {
      throw new PublicAgentContractError("createdBy 不能为空");
    }
    // 协议事实显式校验（合同文件不含 protocol，不默认、不硬编码）
    validateRegistrationProtocol(command.protocol);
    // 合同解析 fail-closed（任何非法输入在写库前拒绝）
    const facts = parsePublicAgentContract(command.contract);
    const capturedAt = command.now ?? now();

    const snapshotId = newId();
    const { header, capabilities, contexts } = buildContractSnapshotRows({
      snapshotId,
      tenantId: command.tenantId,
      agentId: command.agentId,
      protocol: command.protocol,
      facts,
      capturedAt,
      createdBy: command.createdBy,
      newChildId,
    });

    await dependencies.store.transaction(async (session: AgentContractStoreSession) => {
      const agent = await session.findAgent(command.tenantId, command.agentId);
      if (!agent) {
        throw new AgentContractAgentNotFoundError(command.tenantId, command.agentId);
      }
      if (agent.agentKey !== facts.agent.id) {
        throw new AgentContractIdentityMismatchError(agent.id, agent.agentKey, facts.agent.id);
      }
      await session.insertContractSnapshot(header, capabilities, contexts);
    });

    return {
      snapshotId,
      contractDigest: facts.contractDigest,
      capabilityDigest: facts.capabilityDigest,
      contextDigest: facts.contextDigest,
      publicAgentId: facts.agent.id,
      capturedAt,
    };
  };
}
