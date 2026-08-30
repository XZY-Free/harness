/**
 * invokeRequiredAgent — Harness Loop 消费 required Agent capability（专题01 Batch7）集成测试。
 *
 * 真实 MySQL + 真实 loopback A2A Provider（复用 seedAgentCallExecutionScenario，不 mock
 * transport / store / DB，与 start-agent-call.test.ts 一致）。resolveRoute 是注入参数，
 * 测试 mock 返回覆盖为 scenario 真实证据的 agent RouteResolution。
 *
 * 目标不变量（专题01 Batch7 冻结调用链）：
 * 1. completed：required Agent 结果作为受信任 capability result 返回，A2A 走真实 provider。
 * 2. waiting_user：AgentCall waiting_user → 返回 taskId/contextId，resume 复用 SAME AgentCall。
 * 3. failed：required capability 无法满足 → fail closed（绝不 model-only fallback）。
 * 4. Route 解析 unresolved / 非指定 Agent → RequiredAgentUnavailableError（fail closed）。
 * 5. 幂等：同 (turnId, agentId) 只创建一个 AgentCall（logicalCallKey 幂等）。
 * 6. AgentCallBinding 从这次 RouteResolution 冻结 exact agent route facts（Batch4 补漏）。
 */
import { randomUUID } from "node:crypto";
import {
  RequiredAgentUnavailableError,
  invokeRequiredAgent,
} from "@/lib/agents/calls/application/harness-required-agent";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { runtimeRouteResolution } from "@/lib/agents/calls/test/agent-call-test-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { agentCallBindingTable, agentCallTable } from "@/lib/persistence/schema/agent-calls";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import {
  type ExecutionSubject,
  executionSubjectFromUserIdentity,
} from "@/lib/runtime/transport/execution-subject";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function waitForState(
  tenantId: string,
  callId: string,
  expected: "completed" | "failed" | "waiting_user",
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [call] = await db
      .select({ state: agentCallTable.state })
      .from(agentCallTable)
      .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
      .limit(1);
    if (call?.state === expected) return;
    if (Date.now() >= deadline) throw new Error(`AgentCall 未进入测试期望状态 ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** trusted executionSubject（tenant 与 call 一致，满足 startAgentCall 的 execution_subject required）。 */
function subjectFor(
  scenario: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>,
): ExecutionSubject {
  return executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`);
}

/** 构造 mock RouteResolver：返回覆盖为 scenario 真实证据的 agent RouteResolution。 */
function mockResolveRoute(
  scenario: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>,
): RouteResolver {
  return async () => ({
    status: "resolved" as const,
    eligibleCandidateCount: 1,
    resolution: scenario.resolution,
  });
}

describe("invokeRequiredAgent（Batch7 Harness Loop → AgentCall 桥接器）", () => {
  let scenarios: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>[] = [];

  beforeEach(async () => {
    await resetDatabase(db);
    scenarios = [];
  });

  afterEach(async () => {
    // 清理测试播种的 credential env + 关闭 provider。
    for (const s of scenarios) {
      delete process.env[s.credentialEnvVar];
      await s.provider.close();
    }
  });

  async function seedScenario(
    providerScenario: "completed" | "input_required" | "long_running" | "failed",
  ) {
    const scenario = await seedAgentCallExecutionScenario({ providerScenario });
    scenarios.push(scenario);
    return scenario;
  }

  it("long-running：bridge 不等待本地超时，立即返回 pending + SAME callId", async () => {
    const scenario = await seedScenario("long_running");
    const params = {
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      agentId: scenario.agentId,
      input: "长任务",
      executionSubject: subjectFor(scenario),
      resolveRoute: mockResolveRoute(scenario),
    };
    const result = await invokeRequiredAgent(params);

    expect(result).toMatchObject({
      outcome: "pending",
      state: "running",
    });
    const [call] = await db
      .select()
      .from(agentCallTable)
      .where(eq(agentCallTable.id, result.callId))
      .limit(1);
    expect(call?.state).toBe("running");
    await db
      .update(agentCallTable)
      .set({ startedAt: new Date(Date.now() - 31_000) })
      .where(eq(agentCallTable.id, result.callId));
    const replay = await invokeRequiredAgent(params);
    expect(replay).toEqual(result);
    expect(scenario.provider.captured).toHaveLength(1);
  });

  it("completed：required Agent 走真实 A2A → 返回受信任 capability result（fail-open 于 Agent 成功）", async () => {
    const scenario = await seedScenario("completed");
    const params = {
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      agentId: scenario.agentId,
      input: "帮我查一下请假余额",
      executionSubject: subjectFor(scenario),
      resolveRoute: mockResolveRoute(scenario),
    };
    const first = await invokeRequiredAgent(params);
    expect(first).toMatchObject({ outcome: "pending", state: "running" });
    await waitForState(scenario.tenantId, first.callId, "completed");
    const result = await invokeRequiredAgent(params);

    expect(result).toMatchObject({ outcome: "terminal", state: "completed" });
    if (result.outcome === "terminal" && result.state === "completed") {
      expect(result.callId).toBe(first.callId);
      expect(result.callId).toBeTruthy();
      // completed 结果文本来自 A2A provider 的 task 结果（非空）。
      expect(typeof result.resultText).toBe("string");
    }
  });

  it("waiting_user：AgentCall 进入 waiting_user → 返回 taskId/contextId（resume 复用 SAME AgentCall）", async () => {
    const scenario = await seedScenario("input_required");
    const turnId = scenario.turnId;
    const params = {
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      threadId: scenario.threadId,
      turnId,
      agentId: scenario.agentId,
      input: "帮我补充信息",
      executionSubject: subjectFor(scenario),
      resolveRoute: mockResolveRoute(scenario),
    };
    const first = await invokeRequiredAgent(params);
    expect(first).toMatchObject({ outcome: "pending", state: "running" });
    await waitForState(scenario.tenantId, first.callId, "waiting_user");
    const result = await invokeRequiredAgent(params);

    expect(result.outcome).toBe("waiting_user");
    if (result.outcome === "waiting_user") {
      expect(result.callId).toBe(first.callId);
      expect(result.taskId).toBeTruthy();
      expect(result.contextId).toBeTruthy();
      // waiting_user 的 AgentCall 保持存在（resume 复用，不新建）。
      const [call] = await db
        .select()
        .from(agentCallTable)
        .where(
          and(eq(agentCallTable.id, result.callId), eq(agentCallTable.tenantId, scenario.tenantId)),
        )
        .limit(1);
      expect(call?.state).toBe("waiting_user");
    }
  });

  it("failed：required Agent 调用失败 → fail closed（绝不 model-only fallback）", async () => {
    const scenario = await seedScenario("failed");
    const params = {
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      agentId: scenario.agentId,
      input: "触发失败",
      executionSubject: subjectFor(scenario),
      resolveRoute: mockResolveRoute(scenario),
    };
    const first = await invokeRequiredAgent(params);
    expect(first).toMatchObject({ outcome: "pending", state: "running" });
    await waitForState(scenario.tenantId, first.callId, "failed");
    const result = await invokeRequiredAgent(params);

    expect(result).toMatchObject({ outcome: "terminal", state: "failed" });
    if (result.outcome === "terminal" && result.state === "failed") {
      expect(result.callId).toBe(first.callId);
      // fail closed：返回真实 AgentCall 终态码 + 摘要（绝不 model-only fallback）。
      expect(result.errorCode).toBeTruthy();
      expect(result.errorSummary).toBeTruthy();
      // 该 AgentCall 已进入 failed 终态。
      const [call] = await db
        .select()
        .from(agentCallTable)
        .where(
          and(eq(agentCallTable.id, result.callId), eq(agentCallTable.tenantId, scenario.tenantId)),
        )
        .limit(1);
      expect(call?.state).toBe("failed");
    }
  });

  it("Route 解析 unresolved → RequiredAgentUnavailableError（fail closed）", async () => {
    const scenario = await seedScenario("completed");
    const resolveRoute: RouteResolver = async () => ({
      status: "unresolved",
      reason: "no_eligible_route",
      evaluatedCandidateCount: 0,
    });
    await expect(
      invokeRequiredAgent({
        tenantId: scenario.tenantId,
        parentInvocationId: scenario.parentInvocationId,
        threadId: scenario.threadId,
        turnId: scenario.turnId,
        agentId: scenario.agentId,
        input: "x",
        executionSubject: subjectFor(scenario),
        resolveRoute,
      }),
    ).rejects.toThrow(RequiredAgentUnavailableError);
  });

  it("解析结果非 agent target → RequiredAgentUnavailableError（fail closed）", async () => {
    const scenario = await seedScenario("completed");
    // Runtime fail-closed：用合法 runtime resolution（判别 target/evidence 分支），不做 targetKind 覆盖。
    const resolveRoute: RouteResolver = async () => ({
      status: "resolved" as const,
      eligibleCandidateCount: 1,
      resolution: runtimeRouteResolution(),
    });
    await expect(
      invokeRequiredAgent({
        tenantId: scenario.tenantId,
        parentInvocationId: scenario.parentInvocationId,
        threadId: scenario.threadId,
        turnId: scenario.turnId,
        agentId: scenario.agentId,
        input: "x",
        executionSubject: subjectFor(scenario),
        resolveRoute,
      }),
    ).rejects.toThrow(RequiredAgentUnavailableError);
  });

  it("幂等：同 (turnId, agentId) 只创建一个 AgentCall（logicalCallKey 幂等）", async () => {
    const scenario = await seedScenario("completed");
    const turnId = scenario.turnId;
    const params = {
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      threadId: scenario.threadId,
      turnId,
      agentId: scenario.agentId,
      input: "幂等测试",
      executionSubject: subjectFor(scenario),
      resolveRoute: mockResolveRoute(scenario),
    };
    const first = await invokeRequiredAgent(params);
    expect(first).toMatchObject({ outcome: "pending", state: "running" });
    await waitForState(scenario.tenantId, first.callId, "completed");
    const second = await invokeRequiredAgent(params);
    expect(second).toMatchObject({ outcome: "terminal", state: "completed" });
    if (second.outcome === "terminal" && second.state === "completed") {
      // 同 turn 同 agent → 复用 SAME AgentCall（不新建）。
      expect(second.callId).toBe(first.callId);
      const [call] = await db
        .select()
        .from(agentCallTable)
        .where(
          and(
            eq(agentCallTable.parentInvocationId, scenario.parentInvocationId),
            eq(agentCallTable.logicalCallKey, `required-agent:${turnId}:${scenario.agentId}`),
          ),
        )
        .limit(1);
      expect(call).toBeTruthy();
    }
  });

  it("AgentCallBinding 冻结本次 RouteResolution 的 exact agent route facts（Batch4 补漏）", async () => {
    const scenario = await seedScenario("completed");
    // 记录创建出的 AgentCallBinding，断言 facts 冻结自 resolution。
    const turnId = scenario.turnId;
    const result = await invokeRequiredAgent({
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      threadId: scenario.threadId,
      turnId,
      agentId: scenario.agentId,
      input: "binding facts",
      executionSubject: subjectFor(scenario),
      resolveRoute: mockResolveRoute(scenario),
    });
    expect(result).toMatchObject({ outcome: "pending", state: "running" });
    const [binding] = await db
      .select()
      .from(agentCallBindingTable)
      .where(
        and(
          eq(agentCallBindingTable.callId, result.callId),
          eq(agentCallBindingTable.tenantId, scenario.tenantId),
        ),
      )
      .limit(1);
    expect(binding).toBeTruthy();
    // Batch4 补漏：endpoint/identity/credential/network facts 冻结自本次 RouteResolution。
    expect(binding?.endpointRef).toBe(scenario.endpoint);
    expect(binding?.identityMode).toBe("bearer");
    expect(binding?.credentialRefId).toBe(scenario.credentialRefId);
    expect(binding?.networkZone).toBe("private");
    // exact AgentRevision / Contract 证据一并冻结。
    expect(binding?.agentRevisionId).toBe(scenario.agentRevisionId);
    expect(binding?.agentContractSnapshotId).toBe(scenario.agentContractSnapshotId);
  });
});
