import { randomUUID } from "node:crypto";
import { cancelActiveAgentCalls } from "@/lib/agents/calls/application/cancel-active-agent-calls";
import { startAgentCall } from "@/lib/agents/calls/application/start-agent-call";
import {
  EXECUTION_FIXTURE_CONTRACT,
  seedAgentCallExecutionScenario,
} from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { agentCallAttemptTable } from "@/lib/persistence/schema/agent-calls";
import { executionSubjectFromUserIdentity } from "@/lib/runtime/transport/execution-subject";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("cancelAgentCall 冻结能力真值", () => {
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function seed(cancel: boolean) {
    const scenario = await seedAgentCallExecutionScenario({
      providerScenario: "long_running",
      contract: {
        ...EXECUTION_FIXTURE_CONTRACT,
        interaction: { ...EXECUTION_FIXTURE_CONTRACT.interaction, cancel },
      },
    });
    cleanups.push(async () => {
      delete process.env[scenario.credentialEnvVar];
      await scenario.provider.close();
    });
    await startAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: "执行长任务",
      contextEnvironment: {
        tenantId: scenario.tenantId,
        now: new Date(),
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
        executionSubject: executionSubjectFromUserIdentity(
          scenario.tenantId,
          `user:${randomUUID()}`,
        ),
      },
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const [attemptRow] = await db
        .select()
        .from(agentCallAttemptTable)
        .where(eq(agentCallAttemptTable.callId, scenario.callId));
      if (attemptRow?.externalTaskRef) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return scenario;
  }

  it("cancel=true 调用 tasks/cancel 并把 AgentCall 置为 cancelled", async () => {
    const scenario = await seed(true);

    const [result] = await cancelActiveAgentCalls({
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
    });

    expect(result).toMatchObject({
      remoteCancellation: "cancelled",
      call: { id: scenario.callId, state: "cancelled" },
    });
    expect(scenario.provider.rpcMethods).toContain("tasks/cancel");
  });

  it("cancel=false 不发伪取消，AgentCall 保持 active 并明确远端可能继续", async () => {
    const scenario = await seed(false);

    const [result] = await cancelActiveAgentCalls({
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
    });

    expect(result).toMatchObject({
      remoteCancellation: "unsupported",
      call: { id: scenario.callId, state: "running" },
    });
    expect(scenario.provider.rpcMethods).not.toContain("tasks/cancel");
  });
});
