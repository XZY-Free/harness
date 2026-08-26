/**
 * 测试支撑：为已有 Agent 插入一个真实的结构化 AgentContractSnapshot（header + 有序子记录）。
 *
 * 新的 Revision 流（AgentContractSnapshot 权威）要求 DB 级测试使用真实快照行，
 * 不允许 mock 出预计算的结论。本 helper 复用生产解析与行构建纯函数：
 * parsePublicAgentContract + buildContractSnapshotRows + mysqlAgentContractStore.insertContractSnapshot。
 *
 * 事实源：Public Agent Contract 冻结目标模型（AgentContractSnapshot 权威切片）。
 */
import { randomUUID } from "node:crypto";
import { buildContractSnapshotRows } from "@/lib/agents/application/register-agent-contract";
import { parsePublicAgentContract } from "@/lib/agents/domain/public-agent-contract";
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import { hrAgentContract } from "@/lib/agents/test-support/hr-agent-contract";
import type { AgentContractSnapshot } from "@/lib/persistence/schema/agents";

export interface SeedAgentContractSnapshotParams {
  tenantId: string;
  agentId: string;
  createdBy: string;
  /** 缺省使用 hrAgentContract fixture。 */
  contract?: unknown;
  /** 协议事实显式提供（缺省 a2a@0.3.0，与登记测试一致）。 */
  protocol?: { type: string; contractRevision: string };
  capturedAt?: Date;
}

/**
 * 插入结构化合同快照并回读完整 header 行（含 contractDigest/capabilityDigest/contextDigest）。
 */
export async function seedAgentContractSnapshot(
  params: SeedAgentContractSnapshotParams,
): Promise<AgentContractSnapshot> {
  const facts = parsePublicAgentContract(params.contract ?? hrAgentContract);
  const snapshotId = randomUUID();
  const rows = buildContractSnapshotRows({
    snapshotId,
    tenantId: params.tenantId,
    agentId: params.agentId,
    protocol: params.protocol ?? { type: "a2a", contractRevision: "0.3.0" },
    facts,
    capturedAt: params.capturedAt ?? new Date(),
    createdBy: params.createdBy,
    newChildId: randomUUID,
  });
  await mysqlAgentContractStore.transaction((session) =>
    session.insertContractSnapshot(rows.header, rows.capabilities, rows.contexts),
  );
  const header = await mysqlAgentContractStore.transaction((session) =>
    session.findContractSnapshotById(params.tenantId, snapshotId),
  );
  if (!header) {
    throw new Error(`测试 AgentContractSnapshot 未落库: ${snapshotId}`);
  }
  return header;
}
