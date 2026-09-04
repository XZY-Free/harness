import { randomUUID } from "node:crypto";
import { startAgentCall } from "@/lib/agents/calls/application/start-agent-call";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { executionSubjectFromUserIdentity } from "@/lib/runtime/transport/execution-subject";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let scenario: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>> | null = null;

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(async () => {
  if (!scenario) return;
  delete process.env[scenario.credentialEnvVar];
  await scenario.provider.server.close();
  scenario = null;
});

describe("AgentCallBinding Authority", () => {
  it("Agent 发布新 revision 后，重试仍读取创建时冻结的 revision/route", async () => {
    scenario = await seedAgentCallExecutionScenario();
    const frozen = await mysqlAgentCallStore.getBinding({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
    });
    const latest = await scenario.createNewLatestEvidence();
    await mysqlAgentCallStore.finishAttempt({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      attemptNo: 1,
      to: "failed",
      errorCode: "RETRYABLE",
      errorSummary: "retry",
      now: new Date("2026-08-29T00:00:30.000Z"),
    });
    const retry = await mysqlAgentCallStore.createAttempt({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      retryReasonCode: "transport_retry",
      transportChannel: "hosted",
      now: new Date("2026-08-29T00:01:00.000Z"),
    });
    await startAgentCall({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      input: "读取冻结版本",
      contextEnvironment: {
        tenantId: scenario.tenantId,
        executionSubject: executionSubjectFromUserIdentity(
          scenario.tenantId,
          `user:${randomUUID()}`,
        ),
        now: new Date("2026-08-29T00:01:10.000Z"),
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
      },
    });
    const after = await mysqlAgentCallStore.getBinding({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
    });

    expect(retry.attemptNo).toBe(2);
    expect(after?.agentRevisionId).toBe(scenario.agentRevisionId);
    expect(after?.agentRevisionId).not.toBe(latest.newAgentRevisionId);
    expect(after?.routeRevisionId).toBe(frozen?.routeRevisionId);
    expect(scenario.provider.captured).toHaveLength(1);
    delete process.env[latest.newCredentialEnvVar];
  });
});
