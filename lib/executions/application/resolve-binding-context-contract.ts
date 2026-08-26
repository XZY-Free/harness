/**
 * Binding 精确解析 InvocationContextContract（05 §6）。
 *
 * Invocation 的上下文合同只能来自 ExecutionBinding 冻结的 AgentContractSnapshot：
 * - 按 binding.agentContractSnapshotId 精确加载该快照（禁止读"Agent 最新合同"）；
 * - 快照必须属于 Binding 租户；
 * - 快照 header.contextDigest 必须与 Binding 冻结 digest 精确一致，且与按
 *   position 升序重建的结构化 invocation context 子记录重算 digest 一致
 *   （fail-closed，任何漂移都拒绝，而不是回退最新值）。
 *
 * 快照登记后不可修改（append-only），因此"Agent 之后登记新快照/新 Revision"
 * 不会影响已开始 Invocation 使用的 Context Contract。
 */

import type { InvocationContextContract } from "@/lib/agents/domain/public-agent-contract";
import { db } from "@/lib/db/client";
import {
  agentContractInvocationContextTable,
  agentContractSnapshotTable,
} from "@/lib/persistence/schema/agents";
import { and, asc, eq } from "drizzle-orm";

export interface ResolveBindingContextContractInput {
  tenantId: string;
  /** ExecutionBinding 冻结的 AgentContractSnapshot ID（base route 为 null）。 */
  agentContractSnapshotId: string | null;
  /** ExecutionBinding 冻结的 Agent Contract context digest。 */
  agentContextDigest: string | null;
}

export class BindingContextContractError extends Error {
  constructor(
    message: string,
    readonly code: "base_route_not_applicable" | "snapshot_missing" | "contract_digest_mismatch",
  ) {
    super(message);
    this.name = "BindingContextContractError";
  }
}

/**
 * 从 Binding 冻结的快照精确解析 InvocationContextContract。
 *
 * base route（snapshotId=null，§18 Agent Evidence not_applicable）→ 返回 null。
 * Agent Route 缺快照、租户不符或 digest 不一致 → BindingContextContractError（fail-closed）。
 */
export async function resolveBindingContextContract(
  input: ResolveBindingContextContractInput,
): Promise<InvocationContextContract | null> {
  const { tenantId, agentContractSnapshotId, agentContextDigest } = input;

  // Agent evidence all-or-nothing（05 §5）：base route 三元组全 null；Agent Route 全有值。
  if (agentContractSnapshotId === null || agentContextDigest === null) {
    if (agentContractSnapshotId !== null || agentContextDigest !== null) {
      throw new BindingContextContractError(
        "Binding Agent Contract 证据必须 all-or-nothing",
        "snapshot_missing",
      );
    }
    return null;
  }

  const [snapshot] = await db
    .select({ contextDigest: agentContractSnapshotTable.contextDigest })
    .from(agentContractSnapshotTable)
    .where(
      and(
        eq(agentContractSnapshotTable.id, agentContractSnapshotId),
        eq(agentContractSnapshotTable.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!snapshot) {
    throw new BindingContextContractError(
      "Binding 冻结的 AgentContractSnapshot 不存在",
      "snapshot_missing",
    );
  }
  if (snapshot.contextDigest !== agentContextDigest) {
    throw new BindingContextContractError(
      "AgentContractSnapshot contextDigest 与 Binding 冻结值不一致",
      "contract_digest_mismatch",
    );
  }

  // 按 position 升序读取结构化 invocation context 子记录（租户限定）。
  const rows = await db
    .select({ context: agentContractInvocationContextTable })
    .from(agentContractInvocationContextTable)
    .innerJoin(
      agentContractSnapshotTable,
      eq(agentContractInvocationContextTable.snapshotId, agentContractSnapshotTable.id),
    )
    .where(
      and(
        eq(agentContractSnapshotTable.tenantId, tenantId),
        eq(agentContractSnapshotTable.id, agentContractSnapshotId),
      ),
    )
    .orderBy(asc(agentContractInvocationContextTable.position));

  return {
    contexts: rows.map(({ context }) => ({
      contextKind: context.key,
      necessity: context.necessity,
      purpose: context.descriptionZhCn ?? context.descriptionEn ?? undefined,
      provenance: context.declarationSource,
    })),
  };
}
