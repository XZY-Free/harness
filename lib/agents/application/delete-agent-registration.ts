import { randomUUID } from "node:crypto";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { resolveOutboxAppend } from "@/lib/control-plane/events/outbox-append";
import { seedEventDeliveries } from "@/lib/control-plane/events/seed-event-deliveries";
import { db } from "@/lib/db/client";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import { agentTable } from "@/lib/persistence/schema/agents";
import { deploymentRouteSetTable } from "@/lib/persistence/schema/deployment-route";
import { and, eq } from "drizzle-orm";

export class AgentDeletionError extends Error {
  constructor(readonly kind: "missing" | "conflict" | "referenced" | "retired") {
    super(kind);
  }
}
/** 删除登记保留历史。已建立连接的资源交给发布治理处理，不绕过路由账本。 */
export async function deleteAgentRegistration(input: {
  tenantId: string;
  agentId: string;
  expectedVersion: number;
  actor: AuditActor;
  requestId: string;
}) {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agentTable)
      .where(and(eq(agentTable.tenantId, input.tenantId), eq(agentTable.id, input.agentId)))
      .limit(1)
      .for("update");
    if (!agent) throw new AgentDeletionError("missing");
    // DELETE 重放只认可原始或当前版本，避免吞掉不相关的旧请求。
    if (agent.deletedAt && [agent.versionNo, agent.versionNo - 1].includes(input.expectedVersion))
      return;
    if (agent.versionNo !== input.expectedVersion) throw new AgentDeletionError("conflict");
    if (agent.lifecycleState === "retired") throw new AgentDeletionError("retired");
    const references = await tx
      .select({ id: deploymentRouteSetTable.id })
      .from(deploymentRouteSetTable)
      .where(
        and(
          eq(deploymentRouteSetTable.tenantId, input.tenantId),
          eq(deploymentRouteSetTable.agentId, input.agentId),
        ),
      )
      .for("update");
    if (references.length) throw new AgentDeletionError("referenced");
    const after = {
      lifecycleState: "disabled" as const,
      deletedAt: new Date(),
      versionNo: agent.versionNo + 1,
      updatedAt: new Date(),
    };
    await tx
      .update(agentTable)
      .set(after)
      .where(
        and(
          eq(agentTable.id, agent.id),
          eq(agentTable.tenantId, input.tenantId),
          eq(agentTable.versionNo, agent.versionNo),
        ),
      );
    const event = resolveOutboxAppend({
      id: randomUUID(),
      tenantId: input.tenantId,
      eventKey: `agent:${agent.id}:deleted:${after.versionNo}`,
      eventType: "agent.lifecycle.changed",
      aggregateId: agent.id,
      aggregateVersion: after.versionNo,
      payload: { agent_id: agent.id, previous_state: agent.lifecycleState, new_state: "disabled" },
      occurredAt: after.updatedAt,
    });
    await tx.insert(controlPlaneOutboxEvent).values({ ...event, schemaVersion: "1.0" });
    await seedEventDeliveries(tx, event.id, event.eventType, event.occurredAt);
    await recordAuditEvent({
      actor: input.actor,
      actionType: "agents.deleted",
      targetType: "agent",
      targetId: agent.id,
      before: { lifecycleState: agent.lifecycleState, versionNo: agent.versionNo },
      after,
      reason: "管理员删除未连接的智能体登记",
      outcome: "succeeded",
      requestId: input.requestId,
      client: tx,
    });
  });
}
