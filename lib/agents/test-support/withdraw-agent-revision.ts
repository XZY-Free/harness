import { randomUUID } from "node:crypto";
import { createWithdrawAgentRevision } from "@/lib/agents/application/withdraw-agent-revision";
import {
  AgentRevisionWithdrawalNotFoundError,
  AgentRevisionWithdrawalPublicationNotFoundError,
  AgentRevisionWithdrawalStateError,
  AgentWithdrawalVersionConflictError,
} from "@/lib/agents/domain/agent-revision-withdrawal-policy";
import {
  AgentVersionConflictError,
  RevisionNotFoundError,
  RevisionStateError,
} from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentWithdrawalStore } from "@/lib/agents/persistence/mysql-agent-withdrawal-store";
import { db } from "@/lib/db/client";
import {
  type AgentRevisionRow,
  agentRevisionTable,
  agentTable,
} from "@/lib/persistence/schema/control-plane";
import { eq } from "drizzle-orm";

const withdrawAgentRevision = createWithdrawAgentRevision({
  store: mysqlAgentWithdrawalStore,
});

/** 仅供旧集成测试使用无 actor 签名撤回 Revision。 */
export async function withdrawRevision(revisionId: string): Promise<AgentRevisionRow> {
  const [row] = await db
    .select({ revision: agentRevisionTable, agent: agentTable })
    .from(agentRevisionTable)
    .innerJoin(agentTable, eq(agentTable.id, agentRevisionTable.agentId))
    .where(eq(agentRevisionTable.id, revisionId))
    .limit(1);
  if (!row) throw new RevisionNotFoundError(revisionId);

  try {
    const result = await withdrawAgentRevision({
      tenantId: row.agent.tenantId,
      revisionId,
      agentExpectedVersionNo: row.agent.versionNo,
      actor: {
        tenantId: row.agent.tenantId,
        actorType: "system",
        actorId: "test-support",
      },
      reasonCode: "test_support",
      reason: "测试夹具撤回 AgentRevision",
      requestId: randomUUID(),
    });
    return result.revision as AgentRevisionRow;
  } catch (error) {
    if (error instanceof AgentRevisionWithdrawalNotFoundError) {
      throw new RevisionNotFoundError(error.revisionId);
    }
    if (error instanceof AgentRevisionWithdrawalStateError) {
      throw new RevisionStateError(error.revisionId, error.fromState, "withdrawn", error.message);
    }
    if (error instanceof AgentRevisionWithdrawalPublicationNotFoundError) {
      throw new RevisionStateError(revisionId, "published", "withdrawn", error.message);
    }
    if (error instanceof AgentWithdrawalVersionConflictError) {
      throw new AgentVersionConflictError(error.agentId, error.expectedVersionNo);
    }
    throw error;
  }
}
