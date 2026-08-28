import type { AgentSessionBinding } from "@/lib/agents/calls/domain/agent-session-binding";
import type {
  AgentSessionBindingStore,
  StoreAgentSessionBindingInput,
} from "@/lib/agents/calls/persistence/agent-session-binding-store";
/**
 * AgentSessionBinding Store — MySQL 实现。
 *
 * A2A contextId 属于 AgentSessionBinding.externalContextRef。
 * 幂等：UNIQUE(agentRevisionId, routeRevisionId, externalContextRef) 兜底；
 * 并发冲突回查返回已存在行。
 */
import { db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import { agentSessionBindingTable } from "@/lib/persistence/schema/agent-calls";
import { and, eq } from "drizzle-orm";

export const mysqlAgentSessionBindingStore: AgentSessionBindingStore = {
  create: async (input) => {
    try {
      await db.insert(agentSessionBindingTable).values({
        id: input.id,
        tenantId: input.tenantId,
        threadId: input.threadId,
        agentId: input.agentId,
        agentRevisionId: input.agentRevisionId,
        deploymentRouteId: input.deploymentRouteId,
        routeRevisionId: input.routeRevisionId,
        externalContextRef: input.externalContextRef,
        bindingState: "active",
        createdAt: input.now,
        lastUsedAt: input.now,
      });
    } catch (err) {
      if (isMysqlDuplicateEntryError(err)) {
        const [existing] = await db
          .select()
          .from(agentSessionBindingTable)
          .where(
            and(
              eq(agentSessionBindingTable.agentRevisionId, input.agentRevisionId),
              eq(agentSessionBindingTable.routeRevisionId, input.routeRevisionId),
              eq(agentSessionBindingTable.externalContextRef, input.externalContextRef),
            ),
          )
          .limit(1);
        if (existing) return toAgentSessionBinding(existing);
      }
      throw err;
    }
    const [row] = await db
      .select()
      .from(agentSessionBindingTable)
      .where(eq(agentSessionBindingTable.id, input.id))
      .limit(1);
    if (!row) throw new Error("AgentSessionBinding 插入后无法回读");
    return toAgentSessionBinding(row);
  },

  getByContext: async ({ tenantId, agentId, externalContextRef }) => {
    const [row] = await db
      .select()
      .from(agentSessionBindingTable)
      .where(
        and(
          eq(agentSessionBindingTable.tenantId, tenantId),
          eq(agentSessionBindingTable.agentId, agentId),
          eq(agentSessionBindingTable.externalContextRef, externalContextRef),
        ),
      )
      .limit(1);
    return row ? toAgentSessionBinding(row) : null;
  },

  close: async ({ id, tenantId, now }) => {
    const [row] = await db
      .select()
      .from(agentSessionBindingTable)
      .where(
        and(eq(agentSessionBindingTable.id, id), eq(agentSessionBindingTable.tenantId, tenantId)),
      )
      .limit(1)
      .for("update");
    if (!row || row.bindingState !== "active") {
      throw new AgentSessionBindingStateError(id, "close", row?.bindingState ?? "missing");
    }
    await db
      .update(agentSessionBindingTable)
      .set({ bindingState: "closed", closedAt: now })
      .where(eq(agentSessionBindingTable.id, id));
    const [after] = await db
      .select()
      .from(agentSessionBindingTable)
      .where(eq(agentSessionBindingTable.id, id))
      .limit(1);
    if (!after) throw new Error("AgentSessionBinding close 后无法回读");
    return toAgentSessionBinding(after);
  },

  markLost: async ({ id, tenantId, now }) => {
    const [row] = await db
      .select()
      .from(agentSessionBindingTable)
      .where(
        and(eq(agentSessionBindingTable.id, id), eq(agentSessionBindingTable.tenantId, tenantId)),
      )
      .limit(1)
      .for("update");
    if (!row || row.bindingState !== "active") {
      throw new AgentSessionBindingStateError(id, "markLost", row?.bindingState ?? "missing");
    }
    await db
      .update(agentSessionBindingTable)
      .set({ bindingState: "lost", closedAt: now })
      .where(eq(agentSessionBindingTable.id, id));
    const [after] = await db
      .select()
      .from(agentSessionBindingTable)
      .where(eq(agentSessionBindingTable.id, id))
      .limit(1);
    if (!after) throw new Error("AgentSessionBinding markLost 后无法回读");
    return toAgentSessionBinding(after);
  },
};

export class AgentSessionBindingStateError extends Error {
  constructor(
    public readonly id: string,
    public readonly op: string,
    public readonly actual: string,
  ) {
    super(`AgentSessionBinding ${id} 无法执行 ${op}（当前 ${actual}）`);
    this.name = "AgentSessionBindingStateError";
  }
}

function toAgentSessionBinding(
  row: typeof agentSessionBindingTable.$inferSelect,
): AgentSessionBinding {
  return {
    id: row.id,
    tenantId: row.tenantId,
    threadId: row.threadId,
    agentId: row.agentId,
    agentRevisionId: row.agentRevisionId,
    deploymentRouteId: row.deploymentRouteId,
    routeRevisionId: row.routeRevisionId,
    externalContextRef: row.externalContextRef,
    bindingState: row.bindingState,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    closedAt: row.closedAt,
  };
}
