/**
 * Binding 精确解析 InvocationContextContract（05 §6）。
 *
 * Invocation 的上下文合同只能来自 ExecutionBinding 冻结的 AgentDescriptorSnapshot：
 * - 按 binding.agentDescriptorSnapshotId 精确加载该 Snapshot（禁止读"Agent 最新 Descriptor"）；
 * - Snapshot 必须属于 Binding 租户；
 * - Snapshot.invocationContextContractDigest 必须与 Binding 冻结 digest 精确一致
 *   （fail-closed，任何漂移都拒绝，而不是回退最新值）。
 *
 * Snapshot 登记后不可修改（append-only），因此"Agent 之后发布新 Snapshot/新 Revision"
 * 不会影响已开始 Invocation 使用的 Context Contract。
 */

import type { InvocationContextContract } from "@/lib/agents/domain/agent-descriptor";
import { db } from "@/lib/db/client";
import { agentDescriptorSnapshotTable } from "@/lib/persistence/schema/agents";
import { and, eq } from "drizzle-orm";

export interface ResolveBindingContextContractInput {
  tenantId: string;
  /** ExecutionBinding 冻结的 AgentDescriptorSnapshot ID（base route 为 null）。 */
  agentDescriptorSnapshotId: string | null;
  /** ExecutionBinding 冻结的 InvocationContextContract digest。 */
  agentInvocationContextContractDigest: string | null;
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
 * 从 Binding 冻结的 Snapshot 精确解析 InvocationContextContract。
 *
 * base route（snapshotId=null，§18 Agent Evidence not_applicable）→ 返回 null。
 * Agent Route 缺 Snapshot、租户不符或 digest 不一致 → BindingContextContractError（fail-closed）。
 */
export async function resolveBindingContextContract(
  input: ResolveBindingContextContractInput,
): Promise<InvocationContextContract | null> {
  const { tenantId, agentDescriptorSnapshotId, agentInvocationContextContractDigest } = input;

  // Agent evidence all-or-nothing（05 §5）：base route 三元组全 null；Agent Route 全有值。
  if (agentDescriptorSnapshotId === null || agentInvocationContextContractDigest === null) {
    if (agentDescriptorSnapshotId !== null || agentInvocationContextContractDigest !== null) {
      throw new BindingContextContractError(
        "Binding Agent Descriptor 证据必须 all-or-nothing",
        "snapshot_missing",
      );
    }
    return null;
  }

  const [snapshot] = await db
    .select({
      invocationContextContract: agentDescriptorSnapshotTable.invocationContextContract,
      invocationContextContractDigest: agentDescriptorSnapshotTable.invocationContextContractDigest,
    })
    .from(agentDescriptorSnapshotTable)
    .where(
      and(
        eq(agentDescriptorSnapshotTable.id, agentDescriptorSnapshotId),
        eq(agentDescriptorSnapshotTable.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!snapshot) {
    throw new BindingContextContractError(
      "Binding 冻结的 AgentDescriptorSnapshot 不存在",
      "snapshot_missing",
    );
  }
  if (snapshot.invocationContextContractDigest !== agentInvocationContextContractDigest) {
    throw new BindingContextContractError(
      "Snapshot InvocationContextContract digest 与 Binding 冻结值不一致",
      "contract_digest_mismatch",
    );
  }
  return snapshot.invocationContextContract as InvocationContextContract;
}
