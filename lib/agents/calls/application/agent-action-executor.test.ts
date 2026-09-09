import { randomUUID } from "node:crypto";
import { createAgentActionExecutor } from "@/lib/agents/calls/application/agent-action-executor";
import { resumeAgentCallFromUserAction } from "@/lib/agents/calls/application/resume-agent-call-from-user-action";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  EXECUTION_FIXTURE_CONTRACT,
  seedAgentCallExecutionScenario,
  waitForCallTerminal,
} from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { resolveGenericUserAction } from "@/lib/conversations/user-action-resolve-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { capabilityUseTable } from "@/lib/persistence/schema/capability-use";
import { threadEventTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { workspaceAttachmentAccessGrant } from "@/lib/persistence/schema/workspace";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { createProductionInvocationContinuationWorker } from "@/lib/runtime/continuation/production-invocation-continuation-worker";
import { executionSubjectFromUserIdentity } from "@/lib/runtime/transport/execution-subject";
import {
  createManagedWorkspaceAttachment,
  createWorkspaceAttachmentUse,
} from "@/lib/workspace/workspace-queries";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveRoute = createResolveRoute({ store: mysqlRouteEligibilityResolutionStore });

describe("AgentActionExecutor", () => {
  let scenarios: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>[] = [];

  beforeEach(async () => {
    await resetDatabase(db);
    scenarios = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const scenario of scenarios) {
      delete process.env[scenario.credentialEnvVar];
      await scenario.provider.close();
    }
  });

  async function seed(
    providerScenario: "completed" | "long_running" | "input_required" | "confirmation_chain",
    options?: { contract?: unknown },
  ) {
    const scenario = await seedAgentCallExecutionScenario({
      providerScenario,
      contract: options?.contract,
      ...(providerScenario === "input_required" || providerScenario === "confirmation_chain"
        ? {
            contract: {
              ...EXECUTION_FIXTURE_CONTRACT,
              interaction: {
                ...EXECUTION_FIXTURE_CONTRACT.interaction,
                input_required: true,
                resume: true,
              },
            },
            ...(providerScenario === "confirmation_chain"
              ? {
                  agentInterfaceRequirements: {
                    host_controls: {
                      confirmation_action_keys: ["hr.leave.submit"],
                    },
                  },
                }
              : {}),
          }
        : {}),
    });
    scenarios.push(scenario);
    await db.delete(agentCallAttemptTable).where(eq(agentCallAttemptTable.callId, scenario.callId));
    await db.delete(agentCallBindingTable).where(eq(agentCallBindingTable.callId, scenario.callId));
    await db.delete(agentCallTable).where(eq(agentCallTable.id, scenario.callId));
    await db
      .delete(capabilityUseTable)
      .where(eq(capabilityUseTable.invocationId, scenario.parentInvocationId));
    scenario.provider.reset();
    scenario.provider.setScenario(providerScenario);
    return scenario;
  }

  it("使用 Harness task 创建 harness_planned AgentCall，并以 actionId 稳定幂等", async () => {
    const scenario = await seed("long_running");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const action = {
      actionId: "action-agent-1",
      stepNo: 1,
      actionType: "agent.call" as const,
      purposeCode: "query_balance",
      shortPurpose: "查询年假余额",
      payload: {
        agentId: scenario.agentId,
        task: "只查询当前员工的年假余额",
        contextRefs: ["context:employee-subject"],
      },
    };
    const context = {
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      actionDigest: `sha256:${"a".repeat(64)}`,
    };

    const first = await execute(action, context);
    const replay = await execute(action, context);

    expect(first).toMatchObject({
      pending: { kind: "agent_call", state: "running" },
    });
    expect(replay).toEqual(first);
    expect(scenario.provider.captured).toHaveLength(1);
    expect(scenario.provider.captured[0]?.text).toBe(action.payload.task);
    const [call] = await db
      .select()
      .from(agentCallTable)
      .where(
        and(
          eq(agentCallTable.parentInvocationId, scenario.parentInvocationId),
          eq(agentCallTable.sourceRef, action.actionId),
        ),
      )
      .limit(1);
    expect(call).toMatchObject({
      sourceType: "harness_planned",
      logicalCallKey: `harness-action:${action.actionId}:agent:${scenario.agentId}`,
    });
    const [capabilityUse] = await db
      .select()
      .from(capabilityUseTable)
      .where(eq(capabilityUseTable.invocationId, scenario.parentInvocationId))
      .limit(1);
    expect(capabilityUse).toMatchObject({
      capabilityType: "agent",
      capabilityId: scenario.agentId,
      revisionId: scenario.agentRevisionId,
      sourceType: "harness_planned",
      sourceRef: action.actionId,
    });
  });

  it("只把 action 显式选择的 Turn 附件作为短期公共引用发送给 Agent", async () => {
    const scenario = await seed("long_running", {
      contract: {
        ...EXECUTION_FIXTURE_CONTRACT,
        invocation_context: [
          ...EXECUTION_FIXTURE_CONTRACT.invocation_context,
          {
            key: "attachment_references",
            name: { "zh-CN": "附件引用" },
            necessity: "accepted",
          },
        ],
      },
    });
    const [thread] = await db
      .select()
      .from(threadTable)
      .where(eq(threadTable.id, scenario.threadId))
      .limit(1);
    if (!thread) throw new Error("测试 Thread 不存在");
    const attachmentId = randomUUID();
    await createManagedWorkspaceAttachment({
      id: attachmentId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      storageProvider: "workspace",
      resourceRef: `.snow/files/attachment/${attachmentId}/content`,
      resourceFingerprint: `sha256:${"a".repeat(64)}`,
      originalFilename: "工资证明.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      attachedBy: thread.ownerUserId,
    });
    await createWorkspaceAttachmentUse({
      tenantId: scenario.tenantId,
      turnId: scenario.turnId,
      workspaceAttachmentId: attachmentId,
    });
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, thread.ownerUserId),
      resolveRoute,
      transportChannel: "hosted",
    });

    await execute(
      {
        actionId: "action-with-attachment",
        stepNo: 1,
        actionType: "agent.call",
        purposeCode: "read_attachment",
        shortPurpose: "读取用户明确选择的附件",
        payload: {
          agentId: scenario.agentId,
          task: "读取工资证明",
          contextRefs: [`attachment:${attachmentId}`],
        },
      },
      {
        invocationId: scenario.parentInvocationId,
        tenantId: scenario.tenantId,
        threadId: scenario.threadId,
        turnId: scenario.turnId,
        actionDigest: `sha256:${"2".repeat(64)}`,
        deadlineAt: new Date(Date.now() + 60_000),
      },
    );

    const references = scenario.provider.captured[0]?.messageMetadata?.attachment_references;
    expect(references).toEqual([
      {
        reference_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        resource_type: "file",
        display_name: "工资证明.pdf",
        media_type: "application/pdf",
      },
    ]);
    expect(JSON.stringify(references)).not.toContain(".snow/files/attachment");
    expect(await db.select().from(workspaceAttachmentAccessGrant)).toHaveLength(1);
  });

  it("F06 父执行已取消时在创建和出站前停止，不留下 AgentCall 或远端请求", async () => {
    const scenario = await seed("long_running");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const controller = new AbortController();
    controller.abort(new DOMException("parent cancelled", "AbortError"));

    await expect(
      execute(
        {
          actionId: "f06-cancel-before-dispatch",
          stepNo: 1,
          actionType: "agent.call",
          purposeCode: "query_balance",
          shortPurpose: "查询年假余额",
          payload: { agentId: scenario.agentId, task: "不应出站" },
        },
        {
          invocationId: scenario.parentInvocationId,
          tenantId: scenario.tenantId,
          threadId: scenario.threadId,
          turnId: scenario.turnId,
          actionDigest: `sha256:${"f".repeat(64)}`,
          abortSignal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_ACTION_CANCELLED" });
    expect(scenario.provider.captured).toHaveLength(0);
    expect(
      await db
        .select()
        .from(agentCallTable)
        .where(eq(agentCallTable.parentInvocationId, scenario.parentInvocationId)),
    ).toHaveLength(0);
  });

  it("F06 Harness 执行器把父取消透传到 startAgentCall 的 claim/dispatch 边界", async () => {
    const scenario = await seed("long_running");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const controller = new AbortController();
    const claimCurrentAttempt = mysqlAgentCallStore.claimCurrentAttempt.bind(mysqlAgentCallStore);
    vi.spyOn(mysqlAgentCallStore, "claimCurrentAttempt").mockImplementation(async (params) => {
      const claim = await claimCurrentAttempt(params);
      controller.abort(new DOMException("parent cancelled after claim", "AbortError"));
      return claim;
    });
    const actionId = "f06-cancel-inside-start";

    await expect(
      execute(
        {
          actionId,
          stepNo: 1,
          actionType: "agent.call",
          purposeCode: "query_balance",
          shortPurpose: "查询年假余额",
          payload: { agentId: scenario.agentId, task: "不得出站" },
        },
        {
          invocationId: scenario.parentInvocationId,
          tenantId: scenario.tenantId,
          threadId: scenario.threadId,
          turnId: scenario.turnId,
          actionDigest: `sha256:${"1".repeat(64)}`,
          abortSignal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_ACTION_CANCELLED" });
    expect(scenario.provider.requests).toHaveLength(0);
    const [call] = await db
      .select()
      .from(agentCallTable)
      .where(
        and(
          eq(agentCallTable.parentInvocationId, scenario.parentInvocationId),
          eq(agentCallTable.sourceRef, actionId),
        ),
      );
    expect(call).toMatchObject({ state: "cancelled" });
    const [attempt] = await db
      .select()
      .from(agentCallAttemptTable)
      .where(eq(agentCallAttemptTable.callId, call?.id as string));
    expect(attempt).toMatchObject({ attemptState: "cancelled" });
  });

  it("AgentCall 完成后只返回 Agent Observation", async () => {
    const scenario = await seed("completed");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const action = {
      actionId: "action-agent-completed",
      stepNo: 1,
      actionType: "agent.call" as const,
      purposeCode: "query_balance",
      shortPurpose: "查询年假余额",
      payload: { agentId: scenario.agentId, task: "查询当前员工年假余额" },
    };
    const context = {
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      actionDigest: `sha256:${"b".repeat(64)}`,
    };

    const started = await execute(action, context);
    if (started.pending) {
      await waitForCallTerminal(started.pending.callId, scenario.tenantId);
    }
    const result = started.pending ? await execute(action, context) : started;

    expect(result).toMatchObject({
      authorityRef: expect.stringMatching(/^agent-call:/),
      observation: {
        observationType: "agent",
        sourceRefs: [expect.stringMatching(/^agent-call:/)],
        data: { resultText: expect.any(String) },
      },
    });
    expect(result).not.toHaveProperty("pending");
    expect(scenario.provider.captured).toHaveLength(1);
  });

  it("相同 actionId 改写 task 时稳定返回幂等冲突且不重复出站", async () => {
    const scenario = await seed("long_running");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const context = {
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      actionDigest: `sha256:${"c".repeat(64)}`,
    };
    const baseAction = {
      actionId: "action-agent-conflict",
      stepNo: 1,
      actionType: "agent.call" as const,
      purposeCode: "query_balance",
      shortPurpose: "查询年假余额",
      payload: { agentId: scenario.agentId, task: "查询当前员工年假余额" },
    };

    await execute(baseAction, context);
    await expect(
      execute(
        { ...baseAction, payload: { ...baseAction.payload, task: "改为查询其他员工年假余额" } },
        context,
      ),
    ).rejects.toMatchObject({ code: "AGENT_CALL_IDEMPOTENCY_CONFLICT" });
    expect(scenario.provider.captured).toHaveLength(1);
  });

  it("input-required 原子投影 Parent/Turn waiting_user 与关联同一 AgentCall 的 UAR，重放不重复", async () => {
    const scenario = await seed("input_required");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const action = {
      actionId: "action-agent-input",
      stepNo: 1,
      actionType: "agent.call" as const,
      purposeCode: "collect_employee_id",
      shortPurpose: "补充员工编号",
      payload: { agentId: scenario.agentId, task: "查询当前员工年假余额" },
    };
    const context = {
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      actionDigest: `sha256:${"d".repeat(64)}`,
    };

    const first = await execute(action, context);
    const callId = first.pending?.callId as string;
    let waitingCall: typeof agentCallTable.$inferSelect | undefined;
    let projectedRequest: typeof userActionRequestTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      [waitingCall] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, callId));
      const requests = await db.select().from(userActionRequestTable);
      projectedRequest = requests.find(
        (request) => (request.promptJson as Record<string, unknown>).agent_call_id === callId,
      );
      if (projectedRequest || waitingCall?.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waitingCall).toMatchObject({ state: "waiting_user", errorCode: null });
    await createProductionInvocationContinuationWorker(
      "agent-action-executor-input-required-test",
    ).pollOnce();
    const requestsAfterContinuation = await db.select().from(userActionRequestTable);
    projectedRequest = requestsAfterContinuation.find(
      (request) => (request.promptJson as Record<string, unknown>).agent_call_id === callId,
    );
    expect(projectedRequest).toBeTruthy();
    const replay = await execute(action, context);

    expect(first).toMatchObject({
      pending: { kind: "agent_call", state: "waiting_user" },
    });
    expect(replay).toEqual(first);
    const requests = await db.select().from(userActionRequestTable);
    const request = requests.find(
      (row) => (row.promptJson as Record<string, unknown>).agent_call_id === callId,
    );
    expect(request).toMatchObject({
      tenantId: scenario.tenantId,
      invocationId: scenario.parentInvocationId,
      turnId: scenario.turnId,
      requestType: "input",
      purpose: "a2a_input_required",
      requestState: "pending",
    });
    expect(request?.promptJson).toMatchObject({
      agent_call_id: callId,
      agent_call_event_id: expect.any(String),
      task_id: expect.any(String),
      context_id: expect.any(String),
    });
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, scenario.parentInvocationId));
    const [turn] = await db.select().from(turnTable).where(eq(turnTable.id, scenario.turnId));
    expect(invocation?.executionState).toBe("waiting_user");
    expect(turn?.turnState).toBe("waiting_user");
    expect(requests).toHaveLength(1);
    const requestedEvents = await db
      .select()
      .from(threadEventTable)
      .where(eq(threadEventTable.eventType, "user_action.requested"));
    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0]?.payloadJson).toMatchObject({
      request_id: request?.id,
      agent_call_id: callId,
      action_id: request?.harnessActionId,
      harness_action_id: action.actionId,
      task_id: (request?.promptJson as Record<string, unknown>)?.task_id,
      context_id: (request?.promptJson as Record<string, unknown>)?.context_id,
    });

    const changedPreferredAgentId = randomUUID();
    await db
      .update(turnTable)
      .set({ preferredAgentId: changedPreferredAgentId })
      .where(eq(turnTable.id, scenario.turnId));
    const resolved = await resolveGenericUserAction({
      tenantId: scenario.tenantId,
      requestId: request?.id as string,
      resolution: "submit",
      resolvedBy: randomUUID(),
      responseRedactedJson: { text: "2026-09-01" },
    });
    const [resumedTurn] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, scenario.turnId));
    expect(resumedTurn?.turnState).toBe("running");
    expect(resolved.resumeCommand.commandPayloadJson).toMatchObject({
      agent_call_id: callId,
      action_id: request?.harnessActionId,
      task_id: (request?.promptJson as Record<string, unknown>)?.task_id,
      context_id: (request?.promptJson as Record<string, unknown>)?.context_id,
      resume_payload: { text: "2026-09-01" },
    });

    const resumed = await resumeAgentCallFromUserAction({
      tenantId: scenario.tenantId,
      request: resolved.request,
      responseRedactedJson: { text: "2026-09-01" },
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
    });
    expect(resumed).toMatchObject({ resumed: true, callId, state: "completed" });
    expect(scenario.provider.captured).toHaveLength(2);
    expect(scenario.provider.captured[1]).toMatchObject({
      resume: true,
      taskId: (request?.promptJson as Record<string, unknown>)?.task_id,
      contextId: (request?.promptJson as Record<string, unknown>)?.context_id,
      text: "2026-09-01",
    });
    expect(await db.select().from(agentCallTable)).toHaveLength(1);
    expect(changedPreferredAgentId).not.toBe(scenario.agentId);
  });

  it("同一 AgentCall 可连续产生两次 confirmation，分别落为 UAR 并两次复用同一 task/context", async () => {
    const scenario = await seed("confirmation_chain");
    const executionSubject = executionSubjectFromUserIdentity(scenario.tenantId, randomUUID());
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject,
      resolveRoute,
      transportChannel: "hosted",
    });
    const action = {
      actionId: "action-agent-confirmation-chain",
      stepNo: 1,
      actionType: "agent.call" as const,
      purposeCode: "submit_leave",
      shortPurpose: "提交请假",
      payload: { agentId: scenario.agentId, task: "提交我的年假申请" },
    };
    const context = {
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      actionDigest: `sha256:${"e".repeat(64)}`,
    };

    const started = await execute(action, context);
    const callId = started.pending?.callId;
    expect(callId).toBeTruthy();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const [call] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, callId!));
      if (call?.state === "waiting_user") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await createProductionInvocationContinuationWorker(
      "agent-action-executor-confirmation-chain-first",
    ).pollOnce();
    let requests = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.invocationId, scenario.parentInvocationId));
    expect(requests).toHaveLength(1);
    const firstRequest = requests[0]!;
    expect(firstRequest).toMatchObject({
      requestType: "confirmation",
      purpose: "a2a_confirmation",
      requestState: "pending",
    });
    expect(firstRequest.harnessActionId).not.toBe(action.actionId);
    expect(firstRequest.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(firstRequest.promptJson).toMatchObject({
      agent_call_id: callId,
      harness_action_id: action.actionId,
      proposal_id: "proposal-1",
    });

    const firstResolution = await resolveGenericUserAction({
      tenantId: scenario.tenantId,
      requestId: firstRequest.id,
      resolution: "approve",
      resolvedBy: executionSubject.subjectId,
    });
    const afterFirstResume = await resumeAgentCallFromUserAction({
      tenantId: scenario.tenantId,
      request: firstResolution.request,
      responseRedactedJson: null,
      executionSubject,
    });
    expect(afterFirstResume).toMatchObject({ resumed: true, callId, state: "waiting_user" });

    await createProductionInvocationContinuationWorker(
      "agent-action-executor-confirmation-chain-second",
    ).pollOnce();
    requests = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.invocationId, scenario.parentInvocationId));
    expect(requests).toHaveLength(2);
    const secondRequest = requests.find((request) => request.id !== firstRequest.id);
    expect(secondRequest).toMatchObject({
      requestType: "confirmation",
      purpose: "a2a_confirmation",
      requestState: "pending",
    });
    expect(secondRequest?.harnessActionId).not.toBe(firstRequest.harnessActionId);
    expect(secondRequest?.promptJson).toMatchObject({
      agent_call_id: callId,
      harness_action_id: action.actionId,
      proposal_id: "proposal-2",
    });

    const secondResolution = await resolveGenericUserAction({
      tenantId: scenario.tenantId,
      requestId: secondRequest?.id as string,
      resolution: "deny",
      resolvedBy: executionSubject.subjectId,
    });
    await expect(
      resumeAgentCallFromUserAction({
        tenantId: scenario.tenantId,
        request: secondResolution.request,
        responseRedactedJson: null,
        executionSubject,
      }),
    ).resolves.toMatchObject({ resumed: true, callId, state: "completed" });

    expect(await db.select().from(agentCallTable)).toHaveLength(1);
    expect(scenario.provider.captured).toHaveLength(3);
    const firstPrompt = firstRequest.promptJson as Record<string, unknown>;
    expect(scenario.provider.captured[1]).toMatchObject({
      resume: true,
      taskId: firstPrompt.task_id,
      contextId: firstPrompt.context_id,
    });
    expect(scenario.provider.captured[2]).toMatchObject({
      resume: true,
      taskId: firstPrompt.task_id,
      contextId: firstPrompt.context_id,
    });
  });
});
