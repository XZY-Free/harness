import type { AgentCallEventIngress } from "@/lib/agents/calls/domain/agent-call-event-ingress";
import type {
  AcceptAgentCallEventResult,
  AgentCallEventIngressStore,
  StoreAgentCallEventInput,
} from "@/lib/agents/calls/persistence/agent-call-event-ingress-store";
/**
 * AgentCallEventIngress Store — MySQL 实现。
 *
 * 幂等接收：
 * - 先按 (callId, producerEventId) 查重；存在且 payloadHash 相同 → duplicate；
 *   存在且 payloadHash 不同 → hash_conflict（拒绝）。
 * - 不存在 → 插入；UNIQUE(callId, producerSequence) 并发冲突回查（同 seq 不同 hash → 冲突）。
 */
import { db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import {
  agentCallEventIngressTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { and, eq } from "drizzle-orm";

export const mysqlAgentCallEventIngressStore: AgentCallEventIngressStore = {
  accept: async (input): Promise<AcceptAgentCallEventResult> => {
    // 先证明 call 属于本租户（fail-closed）：异租户绝不可见/不可写。
    const [call] = await db
      .select({ id: agentCallTable.id })
      .from(agentCallTable)
      .where(and(eq(agentCallTable.id, input.callId), eq(agentCallTable.tenantId, input.tenantId)))
      .limit(1);
    if (!call) {
      throw new Error(`AgentCall ${input.callId} 不存在或不属于租户`);
    }
    const [byEventId] = await db
      .select()
      .from(agentCallEventIngressTable)
      .where(
        and(
          eq(agentCallEventIngressTable.callId, input.callId),
          eq(agentCallEventIngressTable.tenantId, input.tenantId),
          eq(agentCallEventIngressTable.producerEventId, input.producerEventId),
        ),
      )
      .limit(1);
    if (byEventId) {
      if (byEventId.payloadHash === input.payloadHash && byEventId.candidateType === input.candidateType) {
        return { status: "duplicate", ingress: toAgentCallEventIngress(byEventId) };
      }
      return { status: "hash_conflict" };
    }

    try {
      await db.insert(agentCallEventIngressTable).values({
        id: input.id,
        callId: input.callId,
        tenantId: input.tenantId,
        producerEventId: input.producerEventId,
        producerSequence: input.producerSequence,
        candidateType: input.candidateType,
        payloadHash: input.payloadHash,
        payloadJson: input.payloadJson ?? null,
        ingressState: "accepted",
        receivedAt: input.receivedAt,
      });
    } catch (err) {
      if (isMysqlDuplicateEntryError(err)) {
        // UNIQUE(callId, producerSequence) 冲突 → 回查（tenant-scoped）。
        const [bySeq] = await db
          .select()
          .from(agentCallEventIngressTable)
          .where(
            and(
              eq(agentCallEventIngressTable.callId, input.callId),
              eq(agentCallEventIngressTable.tenantId, input.tenantId),
              eq(agentCallEventIngressTable.producerSequence, input.producerSequence),
            ),
          )
          .limit(1);
        if (bySeq) {
          if (bySeq.payloadHash === input.payloadHash && bySeq.candidateType === input.candidateType) {
            return { status: "duplicate", ingress: toAgentCallEventIngress(bySeq) };
          }
          return { status: "hash_conflict" };
        }
      }
      throw err;
    }

    const [row] = await db
      .select()
      .from(agentCallEventIngressTable)
      .where(eq(agentCallEventIngressTable.id, input.id))
      .limit(1);
    if (!row) throw new Error("AgentCallEventIngress 插入后无法回读");
    return { status: "accepted", ingress: toAgentCallEventIngress(row) };
  },

  markMapped: async ({ ingressId, callId, tenantId, now }) => {
    const [row] = await db
      .select()
      .from(agentCallEventIngressTable)
      .where(
        and(
          eq(agentCallEventIngressTable.id, ingressId),
          eq(agentCallEventIngressTable.callId, callId),
          eq(agentCallEventIngressTable.tenantId, tenantId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) throw new Error(`AgentCallEventIngress ${ingressId} 不存在`);
    if (row.ingressState === "rejected") {
      throw new Error(`AgentCallEventIngress ${ingressId} 已被拒绝，不可标记 mapped`);
    }
    await db
      .update(agentCallEventIngressTable)
      .set({ ingressState: "mapped", mappedAt: now })
      .where(eq(agentCallEventIngressTable.id, ingressId));
    const [after] = await db
      .select()
      .from(agentCallEventIngressTable)
      .where(eq(agentCallEventIngressTable.id, ingressId))
      .limit(1);
    if (!after) throw new Error("AgentCallEventIngress markMapped 后无法回读");
    return toAgentCallEventIngress(after);
  },
};

function toAgentCallEventIngress(
  row: typeof agentCallEventIngressTable.$inferSelect,
): AgentCallEventIngress {
  return {
    id: row.id,
    callId: row.callId,
    tenantId: row.tenantId,
    producerEventId: row.producerEventId,
    producerSequence: Number(row.producerSequence),
    candidateType: row.candidateType,
    payloadHash: row.payloadHash,
    payloadJson: row.payloadJson,
    ingressState: row.ingressState,
    receivedAt: row.receivedAt,
    mappedAt: row.mappedAt,
    rejectedReason: row.rejectedReason,
  };
}
