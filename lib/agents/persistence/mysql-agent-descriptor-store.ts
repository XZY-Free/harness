import type { AgentDescriptorStore } from "@/lib/agents/persistence/agent-descriptor-store";
import { db } from "@/lib/db/client";
import { agentDescriptorSnapshotTable, agentTable } from "@/lib/persistence/schema/agents";
import { and, desc, eq } from "drizzle-orm";

/**
 * MySQL AgentDescriptorStore 实现。
 * Snapshot 登记后不可修改：只提供 insert 与只读查询。
 */
export const mysqlAgentDescriptorStore: AgentDescriptorStore = {
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findAgent(tenantId, agentId) {
          const [agent] = await tx
            .select({ id: agentTable.id, tenantId: agentTable.tenantId })
            .from(agentTable)
            .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, agentId)))
            .limit(1);
          return agent ?? null;
        },
        async insertSnapshot(row) {
          await tx.insert(agentDescriptorSnapshotTable).values(row);
        },
        async findSnapshotById(id) {
          const [row] = await tx
            .select()
            .from(agentDescriptorSnapshotTable)
            .where(eq(agentDescriptorSnapshotTable.id, id))
            .limit(1);
          return row ?? null;
        },
        async listSnapshotsByAgent(tenantId, agentId) {
          return tx
            .select()
            .from(agentDescriptorSnapshotTable)
            .where(
              and(
                eq(agentDescriptorSnapshotTable.tenantId, tenantId),
                eq(agentDescriptorSnapshotTable.agentId, agentId),
              ),
            )
            .orderBy(desc(agentDescriptorSnapshotTable.capturedAt));
        },
      }),
    ),
};
