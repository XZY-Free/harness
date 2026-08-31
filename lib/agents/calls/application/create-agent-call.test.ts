import { randomUUID } from "node:crypto";
import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import { computeAgentCallBindingHash } from "@/lib/agents/calls/domain/agent-call-binding";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { capabilityUseTable } from "@/lib/persistence/schema/capability-use";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-29T00:00:00.000Z");
const scenarios: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>[] = [];
const createAgentCall = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(async () => {
  for (const scenario of scenarios.splice(0)) {
    delete process.env[scenario.credentialEnvVar];
    await scenario.provider.server.close();
  }
});

describe("createAgentCall 应用服务", () => {
  it("只提交 candidate，由 Store 最终事务冻结并原子写 CapabilityUse", async () => {
    const scenario = await seedAgentCallExecutionScenario();
    scenarios.push(scenario);
    const actionId = randomUUID();
    const logicalCallKey = `${scenario.parentInvocationId}:${actionId}:${scenario.agentId}`;
    const result = await createAgentCall({
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      agentId: scenario.agentId,
      agentRevisionId: scenario.agentRevisionId,
      sourceType: "harness_planned",
      sourceRef: actionId,
      logicalCallKey,
      bindingCandidate: scenario.binding,
      now: NOW,
    });
    expect(result.status).toBe("created");
    expect(result.call.creationRequestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      computeAgentCallBindingHash(
        (await mysqlAgentCallStore.getBinding({
          callId: result.call.id,
          tenantId: scenario.tenantId,
        }))!,
      ),
    ).toBe(scenario.bindingHash);
    expect(
      await db
        .select()
        .from(capabilityUseTable)
        .where(eq(capabilityUseTable.invocationId, scenario.parentInvocationId)),
    ).toHaveLength(1);
  });

  it("同 canonical request 重放返回原 Call", async () => {
    const scenario = await seedAgentCallExecutionScenario();
    scenarios.push(scenario);
    const command = {
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      agentId: scenario.agentId,
      agentRevisionId: scenario.agentRevisionId,
      sourceType: "harness_planned" as const,
      sourceRef: scenario.actionId,
      logicalCallKey: scenario.logicalCallKey,
      bindingCandidate: scenario.binding,
      now: NOW,
    };
    const replay = await createAgentCall(command);
    expect(replay.status).toBe("replayed");
    expect(replay.call.id).toBe(scenario.callId);
  });
});
