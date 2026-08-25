/**
 * submitAgentContractRegistration 应用命令：POST /admin/api/v1/agent-registrations 的登记事务。
 *
 * 与 registerAgentContract（Agent 先在、按 agentId 登记）不同，本命令以合同 agent.id 为身份，
 * 单事务 find-or-create：
 * - 解析/校验在开事务前完成（fail-closed，任何非法输入零行落库）；protocol 显式、不默认。
 * - 事务内按 (tenantId, agentKey=合同 agent.id) 查找 Agent：
 *   - 缺失且 actor 为 user → 创建 draft Agent（displayName=合同 name zh-CN、ownerUserId=actor.userId）；
 *   - 缺失且 actor 为 service → 拒绝（service 主体不得成为首次创建 Agent 的 owner）；
 *   - 存在且 retired/deleted → 拒绝；存在且 draft/enabled/disabled → 原样复用（不覆盖 owner/lifecycle）。
 * - 随后插入不可变快照 header + 有序子记录；子行失败连同新建 Agent 整体回滚。
 * - 并发依赖 Agent (tenantId, agentKey) 唯一键兜底：至少一个请求失败，绝不产生两个 Agent，
 *   也绝不把 DB 冲突吞成假成功。
 *
 * 事实源：Public Agent Contract 登记流（agent-registrations 端点冻结目标模型）。
 */
import { randomUUID } from "node:crypto";
import {
  type ContractSnapshotRows,
  type RegistrationProtocolFacts,
  buildContractSnapshotRows,
  validateRegistrationProtocol,
} from "@/lib/agents/application/register-agent-contract";
import {
  PublicAgentContractError,
  type PublicAgentContractFacts,
  parsePublicAgentContract,
} from "@/lib/agents/domain/public-agent-contract";
import type {
  AgentContractStore,
  AgentContractStoreSession,
} from "@/lib/agents/persistence/agent-contract-store";
import type { AgentContractRegistrationTarget } from "@/lib/agents/persistence/agent-contract-store";
import type {
  AgentContractCapabilityRow,
  AgentContractInvocationContextRow,
  AgentContractSnapshot,
} from "@/lib/persistence/schema/agents";

/** 登记主体：SSO 管理员（成为首次创建 Agent 的 owner）或 CI/CD Service Identity。 */
export type AgentContractRegistrationActor =
  | { kind: "user"; userId: string }
  | { kind: "service"; serviceId: string };

export interface SubmitAgentContractRegistrationCommand {
  tenantId: string;
  /** 协议事实：合同文件不含 protocol，由登记方显式提供。 */
  protocol: RegistrationProtocolFacts;
  /** 管理员提供的 agent-contract.json（request-only 输入，不整体持久化）。 */
  contract: unknown;
  actor: AgentContractRegistrationActor;
}

/** 登记结果：Agent 稳定事实 + 快照结构化事实（camelCase 应用层形态；wire 投影另行构建）。 */
export interface SubmitAgentContractRegistrationResult {
  agent: {
    id: string;
    agentKey: string;
    displayName: string;
    lifecycleState: string;
    /** 本次登记是否新建了 Agent（audit 用；不参与 wire 投影）。 */
    created: boolean;
  };
  contract: {
    snapshotId: string;
    contractVersion: string;
    publicAgentId: string;
    publicAgentVersion: string;
    protocolType: string;
    protocolContractRevision: string;
    contractDigest: string;
    interaction: PublicAgentContractFacts["interaction"];
    capabilities: PublicAgentContractFacts["capabilities"];
    invocationContexts: PublicAgentContractFacts["invocationContexts"];
    resultContract: { fields: string[]; errorCodes: string[] };
    capturedAt: Date;
    createdBy: string;
  };
}

/** 登记被业务规则拒绝（service 首建 / retired / deleted 目标）。 */
export class AgentContractRegistrationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentContractRegistrationRejectedError";
  }
}

// ─── wire 投影（POST 响应与 GET 列表共用）──────────────────

/** 已持久化的合同快照聚合（header + 按 position 升序的子记录）。 */
export interface AgentContractSnapshotAggregate {
  header: AgentContractSnapshot;
  capabilities: AgentContractCapabilityRow[];
  contexts: AgentContractInvocationContextRow[];
}

/**
 * 把持久化快照聚合投影为 snake_case wire 结构化合同（POST 201 与 GET 列表共用，
 * 保证两端逐字段一致）。包含每个持久化对应事实；不含任何原始合同对象/整节 JSON 包装、
 * URL、secret 或内部行 id。declaration_source 取权威持久化 provenance 列。
 */
export function projectAgentContractWire(aggregate: AgentContractSnapshotAggregate): {
  snapshot_id: string;
  contract_version: string;
  public_agent_version: string;
  protocol_type: string;
  protocol_contract_revision: string;
  contract_digest: string;
  interaction: Record<string, unknown>;
  capabilities: Array<Record<string, unknown>>;
  invocation_context: Array<Record<string, unknown>>;
  result_contract: Record<string, unknown>;
  captured_at: Date;
} {
  const h = aggregate.header;
  return {
    snapshot_id: h.id,
    contract_version: h.contractVersion,
    public_agent_version: h.publicAgentVersion,
    protocol_type: h.protocolType,
    protocol_contract_revision: h.protocolContractRevision,
    contract_digest: h.contractDigest,
    interaction: {
      streaming_transport: h.streamingTransport,
      incremental_content: h.incrementalContent,
      input_required: h.inputRequired,
      resume: h.resume,
      cancel: h.cancel,
      durable_task_recovery: h.durableTaskRecovery,
      supported_locales: h.supportedLocales,
    },
    capabilities: aggregate.capabilities.map((c) => ({
      key: c.key,
      name: { "zh-CN": c.nameZhCn, en: c.nameEn },
      description: { "zh-CN": c.descriptionZhCn, en: c.descriptionEn },
      tags: c.tags,
      examples: c.examples,
      input_modes: c.inputModes,
      output_modes: c.outputModes,
    })),
    invocation_context: aggregate.contexts.map((c) => ({
      key: c.key,
      name: { "zh-CN": c.nameZhCn, en: c.nameEn },
      description: { "zh-CN": c.descriptionZhCn, en: c.descriptionEn },
      necessity: c.necessity,
      applies_to: c.appliesTo,
      trust_requirement: c.trustRequirement,
      declaration_source: c.declarationSource,
    })),
    result_contract: {
      fields: h.resultFields,
      error_codes: h.errorCodes,
      notes: { "zh-CN": h.resultNotesZhCn, en: h.resultNotesEn },
    },
    captured_at: h.capturedAt,
  };
}

/**
 * 读取某 Agent 的全部快照聚合（最新优先）。header 与子记录查询均租户限定；
 * 子记录按 position 升序（合同声明顺序）。GET 列表端点直接复用。
 */
export async function loadAgentContractSnapshotsByAgent(
  store: AgentContractStore,
  tenantId: string,
  agentId: string,
): Promise<AgentContractSnapshotAggregate[]> {
  return store.transaction(async (session) => {
    const headers = await session.listContractSnapshotsByAgent(tenantId, agentId);
    const aggregates: AgentContractSnapshotAggregate[] = [];
    for (const header of headers) {
      aggregates.push({
        header,
        capabilities: await session.listCapabilities(tenantId, header.id),
        contexts: await session.listInvocationContexts(tenantId, header.id),
      });
    }
    return aggregates;
  });
}

function actorIdentifier(actor: AgentContractRegistrationActor): string {
  if (actor.kind === "user") {
    if (!actor.userId || actor.userId.trim() === "") {
      throw new PublicAgentContractError("actor.userId 不能为空");
    }
    return actor.userId;
  }
  if (!actor.serviceId || actor.serviceId.trim() === "") {
    throw new PublicAgentContractError("actor.serviceId 不能为空");
  }
  return actor.serviceId;
}

export function createSubmitAgentContractRegistration(dependencies: {
  store: AgentContractStore;
  now?: () => Date;
  /** 新建 Agent 的 id 生成器（与快照/子记录 id 分离注入）。 */
  newAgentId?: () => string;
  /** 快照 id 生成器。 */
  newId?: () => string;
  /** 子记录 id 生成器。 */
  newChildId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newAgentId = dependencies.newAgentId ?? randomUUID;
  const newId = dependencies.newId ?? randomUUID;
  const newChildId = dependencies.newChildId ?? randomUUID;

  return async function submitAgentContractRegistration(
    command: SubmitAgentContractRegistrationCommand,
  ): Promise<SubmitAgentContractRegistrationResult> {
    // 1. 事务前全部校验（fail-closed：零行落库）
    const createdBy = actorIdentifier(command.actor);
    validateRegistrationProtocol(command.protocol);
    const facts = parsePublicAgentContract(command.contract);
    const capturedAt = now();

    const agentAndRows = await dependencies.store.transaction(
      async (session: AgentContractStoreSession) => {
        // 2. find-or-create：身份是合同 agent.id，租户限定
        const existing = await session.findAgentByKey(command.tenantId, facts.agent.id);
        let agent: Pick<
          AgentContractRegistrationTarget,
          "id" | "agentKey" | "displayName" | "lifecycleState"
        >;
        let created = false;
        if (!existing) {
          if (command.actor.kind !== "user") {
            throw new AgentContractRegistrationRejectedError(
              `service 主体不能首次登记创建 Agent（agentKey=${facts.agent.id}）：Agent 必须先由 SSO 管理员登记建立 owner`,
            );
          }
          const newAgent = {
            id: newAgentId(),
            tenantId: command.tenantId,
            agentKey: facts.agent.id,
            displayName: facts.agent.nameZhCn,
            ownerUserId: command.actor.userId,
            lifecycleState: "draft" as const,
          };
          await session.insertAgent(newAgent);
          agent = newAgent;
          created = true;
        } else {
          if (existing.deletedAt !== null) {
            throw new AgentContractRegistrationRejectedError(
              `目标 Agent 已删除，拒绝登记：agentKey=${existing.agentKey}`,
            );
          }
          if (existing.lifecycleState === "retired") {
            throw new AgentContractRegistrationRejectedError(
              `目标 Agent 已退役，拒绝登记：agentKey=${existing.agentKey}`,
            );
          }
          // draft/enabled/disabled：原样复用，不覆盖 owner/lifecycle/displayName
          agent = existing;
        }

        // 3. 快照行构建 + 写入（子行失败 → 新建 Agent 一并回滚）
        const snapshotId = newId();
        const rows: ContractSnapshotRows = buildContractSnapshotRows({
          snapshotId,
          tenantId: command.tenantId,
          agentId: agent.id,
          protocol: command.protocol,
          facts,
          capturedAt,
          createdBy,
          newChildId,
        });
        await session.insertContractSnapshot(rows.header, rows.capabilities, rows.contexts);
        return { agent, created, rows, snapshotId };
      },
    );

    const { agent, created, rows, snapshotId } = agentAndRows;
    return {
      agent: {
        id: agent.id,
        agentKey: agent.agentKey,
        displayName: agent.displayName,
        lifecycleState: agent.lifecycleState,
        created,
      },
      contract: {
        snapshotId,
        contractVersion: rows.header.contractVersion,
        publicAgentId: rows.header.publicAgentId,
        publicAgentVersion: rows.header.publicAgentVersion,
        protocolType: rows.header.protocolType,
        protocolContractRevision: rows.header.protocolContractRevision,
        contractDigest: rows.header.contractDigest,
        interaction: facts.interaction,
        capabilities: facts.capabilities,
        invocationContexts: facts.invocationContexts,
        resultContract: { fields: facts.resultFields, errorCodes: facts.errorCodes },
        capturedAt,
        createdBy,
      },
    };
  };
}
