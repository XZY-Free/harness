import {
  type HostControlCapabilityPolicy,
  parseHostControlCapabilityPolicy,
} from "@/lib/agents/calls/transport/a2a/host-control-contract";
import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { and, eq } from "drizzle-orm";

/** 从 exact AgentRevision 读取 Host Control 能力；缺失能力声明即全拒绝。 */
export async function loadHostControlCapabilityPolicy(
  tenantId: string,
  agentRevisionId: string,
): Promise<HostControlCapabilityPolicy> {
  const [row] = await db
    .select({ requirements: agentRevisionTable.agentInterfaceRequirementsJson })
    .from(agentRevisionTable)
    .innerJoin(agentTable, eq(agentTable.id, agentRevisionTable.agentId))
    .where(and(eq(agentRevisionTable.id, agentRevisionId), eq(agentTable.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new Error("AgentRevision 不存在或不属于当前租户");
  return parseHostControlCapabilityPolicy(row.requirements);
}
