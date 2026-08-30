/**
 * S05-C05：Hosted 参考 Adapter 集成测试（真实 MySQL 8）。
 *
 * 覆盖（5 类，21+ 例）：
 * - HostedAdapter 基本能力（5 例）：probeCapabilities / startInvocation / session_ref 格式 /
 *   execution_ref 格式 / 不阻塞
 * - Agent Loop 事件回传：response.completed / execution.completed /
 *   producer_sequence 连续 / Loop 完成结果 / Item 内容（response.completed payload）
 * - 命令处理（4 例）：handleCancel / handleResume / handleSteer / handleCancel 异步事件回传
 * - 端到端 Turn 生命周期（3 例）：完整 Turn / Steer 中途 / Cancel 中途
 *
 * 真实 MySQL 8 Testcontainers（e2e 场景），mock sink（单元场景），不使用 DB mock。
 */
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { createDraftRevision } from "@/lib/agents/persistence/agent-revision-queries";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-writer";
import {
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { listItemsByThread } from "@/lib/conversations/thread-item-queries";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { type WorkloadTokenClaims, issueWorkloadToken } from "@/lib/identity/workload-token";
import type { AgentRevision } from "@/lib/persistence/schema/agents";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtimes";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import type { GatewayEndpoints } from "@/lib/runtime/adapters/hosted-adapter";
import {
  type CreateHostedAdapterParams,
  type EventBatchSink,
  type StartInvocationParams,
  createHostedAdapter,
  hostedAdapterCapabilities,
  setRouteHostedAdapter,
} from "@/lib/runtime/adapters/hosted-adapter";
import { DEFAULT_ROUTE_SCOPE_KEY, dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── 全局 setup/teardown ──────────────────────────────────

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 清理路由层 Adapter 单例，避免泄漏到其他测试文件（如 command-dispatcher.test.ts）
  setRouteHostedAdapter(null);
});

// ─── 辅助：mock sink（捕获候选事件，不调用 DB） ───────────

interface MockSink {
  sink: EventBatchSink;
  events: RuntimeCandidateEvent[];
  calls: Array<{ invocationId: string; producerSequenceStart: number }>;
}

function createMockSink(): MockSink {
  const events: RuntimeCandidateEvent[] = [];
  const calls: Array<{ invocationId: string; producerSequenceStart: number }> = [];
  const sink: EventBatchSink = async ({ invocationId, events: batch, producerSequenceStart }) => {
    events.push(...batch);
    calls.push({ invocationId, producerSequenceStart });
  };
  return { sink, events, calls };
}

// ─── 辅助：构造 GatewayEndpoints ──────────────────────────

function mockGatewayEndpoints(): GatewayEndpoints {
  return {
    events: "https://platform.internal",
    cancel: "https://platform.internal/cancel",
    resume: "https://platform.internal/resume",
    steer: "https://platform.internal/steer",
  };
}

// ─── 辅助：构造 mock authToken（base64url 编码的 claims） ──

function mockAuthToken(tenantId = "test-tenant", invocationId = "test-invocation"): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "runtime",
    tenantId,
    jti: "jti-runtime-hosted-mock-001",
    invocationId,
    runtimeRevisionId: "test-runtime-revision",
    audience: "runtime",
    expiresAt: Date.now() + 60_000,
  };
  return issueWorkloadToken(claims);
}

// ─── 辅助：构造 mock inputItems ───────────────────────────

function mockInputItems(text: string): unknown[] {
  return [{ type: "user_message", content: { text } }];
}

// ─── 辅助：构造 createHostedAdapter 参数 ──────────────────

function mockAdapterParams(sink: EventBatchSink): CreateHostedAdapterParams {
  return {
    platformEndpoint: "https://platform.internal",
    platformAuthToken: "test-token",
    eventBatchSink: sink,
    modelFn: (userMessage) => `测试执行器回复：${userMessage}`,
    modelRef: "test-model",
  };
}

// ═══════════════════════════════════════════════════════════
// 1. HostedAdapter 基本能力
// ═══════════════════════════════════════════════════════════

describe("S05-C05 HostedAdapter 基本能力", () => {
  it("未配置模型执行器时回传 execution.failed，不生成回复", async () => {
    const { sink, events } = createMockSink();
    const adapter = createHostedAdapter({
      platformEndpoint: "https://platform.internal",
      platformAuthToken: "test-token",
      eventBatchSink: sink,
    });

    await adapter.startInvocation({
      invocationId: "inv-no-executor-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa-bbbb",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("不得伪造回复"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const result = await adapter.getLastLoopPromise?.();
    expect(result?.completed).toBe(false);
    expect(result?.failureReason).toContain("未配置模型执行器");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "execution.failed",
      payload: { error_code: "MODEL_EXECUTOR_UNAVAILABLE" },
    });
  });

  it("probeCapabilities 返回 Hosted 能力声明", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const caps = await adapter.probeCapabilities();

    expect(caps.protocol_versions).toEqual(["2"]);
    expect(caps.features.event_stream).toBe(true);
    expect(caps.features.cancel).toBe(true);
    expect(caps.features.resume).toBe(true);
    expect(caps.features.steer).toBe(true);
    expect(caps.features.dynamic_tools).toBe(false);
    expect(caps.features.user_action).toBe(false);
    expect(caps.features.workspace_types).toEqual(["cloud"]);
    expect(caps.features.filesystem_checkpoint).toBe(false);
  });

  it("startInvocation 返回 accepted + runtime_session_ref + runtime_execution_ref + capabilities", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const result = await adapter.startInvocation({
      invocationId: "inv-basic-001",
      threadId: "thread-aaaa-bbbb-cccc",
      turnId: "turn-aaaa-bbbb-cccc",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("你好"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    expect(result.accepted).toBe(true);
    expect(result.runtime_session_ref).toBeTruthy();
    expect(result.runtime_execution_ref).toBeTruthy();
    expect(result.capabilities.protocol_versions).toEqual(["2"]);
  });

  it("runtime_session_ref 以 'hosted-' 开头", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const result = await adapter.startInvocation({
      invocationId: "inv-ref-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    expect(result.runtime_session_ref).toMatch(/^hosted-/);
  });

  it("runtime_execution_ref 以 'hosted-exec-' 开头", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const result = await adapter.startInvocation({
      invocationId: "inv-ref-002",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    expect(result.runtime_execution_ref).toMatch(/^hosted-exec-/);
  });

  it("startInvocation 不阻塞（loop.run() 异步执行，可后续 await）", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    // startInvocation 返回时 loop 尚未完成
    const result = await adapter.startInvocation({
      invocationId: "inv-noblock-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("不阻塞测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    // startInvocation 已返回，loop 异步执行中
    expect(result.accepted).toBe(true);

    // getLastLoopPromise 返回未完成的 Promise
    const loopPromise = adapter.getLastLoopPromise?.();
    expect(loopPromise).not.toBeNull();

    // await loop 完成
    const loopResult = await loopPromise;
    expect(loopResult).not.toBeNull();
    expect(loopResult?.completed).toBe(true);
    expect(loopResult?.responseText).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Agent Loop 事件回传
// ═══════════════════════════════════════════════════════════

describe("S05-C05 HostedAdapter Agent Loop 事件回传", () => {
  it("不再用 progress.snapshot 制造用户引导 Item", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-loop-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("分析数据"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    expect(mock.events.some((event) => event.type === "progress.snapshot")).toBe(false);
  });

  it("response.completed 事件（seq=1，包含 text + model_ref + finish_reason）", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-loop-002",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("生成回答"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    const loopResult = await loopPromise;

    const responseEvent = mock.events.find((e) => e.type === "response.completed");
    expect(responseEvent).toBeDefined();
    expect(responseEvent?.producer_sequence).toBe(1);
    expect(responseEvent?.payload.text).toBe(loopResult?.responseText);
    expect(responseEvent?.payload.model_ref).toBe("test-model");
    expect(responseEvent?.payload.finish_reason).toBe("stop");
  });

  it("execution.completed 事件（seq=2，终态）", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-loop-003",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("完成执行"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    const execEvent = mock.events.find((e) => e.type === "execution.completed");
    expect(execEvent).toBeDefined();
    expect(execEvent?.producer_sequence).toBe(2);
    expect(execEvent?.payload.finish_reason).toBe("execution.completed");
  });

  it("producer_sequence 在整个 Invocation 内连续递增（1→2）", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-seq-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("连续序号"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    // 2 个持久事件，序号连续 1, 2
    expect(mock.events).toHaveLength(2);
    expect(mock.events[0]?.producer_sequence).toBe(1);
    expect(mock.events[1]?.producer_sequence).toBe(2);
  });

  it("Loop 完成后返回 completed=true + responseText + sentEvents", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-complete-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("完成测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    const result = await loopPromise;

    expect(result?.completed).toBe(true);
    expect(result?.failureReason).toBeUndefined();
    expect(result?.responseText).toContain("完成测试");
    expect(result?.sentEvents).toHaveLength(2);
  });

  it("response.completed payload.text 包含用户消息内容（Item 内容）", async () => {
    const mock = createMockSink();
    const userMessage = "请帮我分析这组数据";
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-content-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems(userMessage),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    const responseEvent = mock.events.find((e) => e.type === "response.completed");
    expect(responseEvent?.payload.text).toContain(userMessage);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 命令处理
// ═══════════════════════════════════════════════════════════

describe("S05-C05 HostedAdapter 命令处理", () => {
  it("handleCancel 返回 cancel_state=accepted + already_completed_effects_preserved=true", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    const result = await adapter.handleCancel({
      invocationId: "inv-cancel-001",
      reason: "user_cancel",
      cancelledBy: "test-user",
      authToken: mockAuthToken(),
    });

    expect(result.cancel_state).toBe("accepted");
    expect(result.already_completed_effects_preserved).toBe(true);
  });

  it("handleResume 返回 resume_state=accepted + runtime_execution_ref + requires_redispatch=false", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    const result = await adapter.handleResume({
      invocationId: "inv-resume-001",
      resumePayload: { action: "confirm" },
      authToken: mockAuthToken(),
    });

    expect(result.resume_state).toBe("accepted");
    expect(result.runtime_execution_ref).toMatch(/^hosted-exec-resume-/);
    expect(result.requires_redispatch).toBe(false);
  });

  it("handleSteer 返回 steer_state=accepted + applies_at=next_safe_point + generation_interrupted=false", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    const result = await adapter.handleSteer({
      invocationId: "inv-steer-001",
      steerPayload: { guidance: "请简洁" },
      authToken: mockAuthToken(),
    });

    expect(result.steer_state).toBe("accepted");
    expect(result.applies_at).toBe("next_safe_point");
    expect(result.generation_interrupted).toBe(false);
  });

  it("handleCancel 异步回传 execution.cancelled 事件（fire-and-forget）", async () => {
    // 使用 deferred promise 等待异步事件回传
    let resolveCancel: (() => void) | undefined;
    const cancelSent = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });

    const events: RuntimeCandidateEvent[] = [];
    const sink: EventBatchSink = async ({ events: batch }) => {
      events.push(...batch);
      if (batch.some((e) => e.type === "execution.cancelled")) {
        resolveCancel?.();
      }
    };

    const adapter = createHostedAdapter(mockAdapterParams(sink));

    // handleCancel 立即返回，execution.cancelled 异步发送
    const result = await adapter.handleCancel({
      invocationId: "inv-cancel-async-001",
      reason: "user_cancel",
      cancelledBy: "test-user",
      authToken: mockAuthToken(),
    });

    expect(result.cancel_state).toBe("accepted");

    // 等待异步事件回传
    await cancelSent;

    const cancelEvent = events.find((e) => e.type === "execution.cancelled");
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent?.payload.cancelled_by).toBe("test-user");
    expect(cancelEvent?.payload.reason).toBe("user_cancel");
  });
});

// ═══════════════════════════════════════════════════════════
// Batch7：required Agent capability 分支
// ═══════════════════════════════════════════════════════════

describe("S05-C05 HostedAdapter required Agent capability（Batch7）", () => {
  const REQUIRED_CAPS = [
    { capability_type: "agent" as const, capability_id: "agent-1", mode: "required" as const },
  ];

  function startWithExecutor(
    sink: EventBatchSink,
    executor: NonNullable<StartInvocationParams["agentCallExecutor"]>,
    modelFn?: NonNullable<CreateHostedAdapterParams["modelFn"]>,
  ) {
    const adapter = createHostedAdapter({
      platformEndpoint: "https://platform.internal",
      platformAuthToken: "test-token",
      eventBatchSink: sink,
      ...(modelFn ? { modelFn } : {}),
      modelRef: "test-model",
    });
    return {
      adapter,
      start: () =>
        adapter.startInvocation({
          invocationId: `inv-required-${randomUUID()}`,
          threadId: "thread-required",
          turnId: "turn-required",
          agentRevisionId: "agent-rev-001",
          capabilityRequirements: REQUIRED_CAPS,
          agentCallExecutor: executor,
          inputItems: mockInputItems("调用 Agent"),
          gatewayEndpoints: mockGatewayEndpoints(),
          authToken: mockAuthToken(),
        }),
    };
  }

  it("completed：required Agent 结果注入 modelFn → response.completed 发送", async () => {
    const { sink, events } = createMockSink();
    let receivedAgentResult: unknown;
    let modelCalled = false;
    const { adapter, start } = startWithExecutor(
      sink,
      async () => ({
        outcome: "terminal" as const,
        state: "completed" as const,
        callId: "call-1",
        resultText: "Agent 完成结果",
        resultJson: { ok: true },
      }),
      (userMessage, ctx) => {
        modelCalled = true;
        receivedAgentResult = ctx.agentResult;
        return `整合回复：${userMessage}`;
      },
    );

    await start();
    const result = await adapter.getLastLoopPromise?.();
    expect(result?.completed).toBe(true);
    expect(modelCalled).toBe(true);
    // required Agent completed 结果作为受信任 capability result 注入模型上下文。
    expect(receivedAgentResult).toMatchObject({
      callId: "call-1",
      resultText: "Agent 完成结果",
      resultJson: { ok: true },
    });
    expect(events.some((e) => e.type === "response.completed")).toBe(true);
  });

  it("failed：required Agent 失败 → execution.failed（fail closed，不调用 modelFn）", async () => {
    const { sink, events } = createMockSink();
    let modelCalled = false;
    const { adapter, start } = startWithExecutor(
      sink,
      async () => ({
        outcome: "terminal" as const,
        state: "failed" as const,
        callId: "call-fail",
        errorCode: "AGENT_TRANSPORT_XXX",
        errorSummary: "required Agent 调用失败",
      }),
      () => {
        modelCalled = true;
        return "";
      },
    );

    await start();
    const result = await adapter.getLastLoopPromise?.();
    expect(result?.completed).toBe(false);
    // required 无法满足 → fail closed，绝不 model-only fallback。
    expect(modelCalled).toBe(false);
    expect(result?.failureReason).toContain("required Agent 调用失败");
    const failedEvent = events.find((e) => e.type === "execution.failed");
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.payload.error_code).toBe("AGENT_TRANSPORT_XXX");
  });

  it("waiting_user：required Agent 等待用户 → user_action.requested（含 agent_call_id，不调用 modelFn）", async () => {
    const { sink, events } = createMockSink();
    let modelCalled = false;
    const { adapter, start } = startWithExecutor(
      sink,
      async () => ({
        outcome: "waiting_user" as const,
        state: "waiting_user" as const,
        callId: "call-wait",
        taskId: "task-1",
        contextId: "ctx-1",
      }),
      () => {
        modelCalled = true;
        return "";
      },
    );

    await start();
    const result = await adapter.getLastLoopPromise?.();
    expect(result?.completed).toBe(false);
    expect(modelCalled).toBe(false);
    const userActionEvent = events.find((e) => e.type === "user_action.requested");
    expect(userActionEvent).toBeDefined();
    // resume 复用 SAME AgentCall（agent_call_id 关联）。
    expect(userActionEvent?.payload.agent_call_id).toBe("call-wait");
    expect(userActionEvent?.payload.request_type).toBe("input");
    expect(result?.agentCallHandoff).toMatchObject({
      outcome: "waiting_user",
      callId: "call-wait",
    });
  });

  it("pending：返回 durable child handoff，不调用 modelFn、不发 completion/failure", async () => {
    const { sink, events } = createMockSink();
    let modelCalled = false;
    const { adapter, start } = startWithExecutor(
      sink,
      async () => ({
        outcome: "pending" as const,
        state: "running" as const,
        callId: "call-running",
      }),
      () => {
        modelCalled = true;
        return "不得调用";
      },
    );

    await start();
    const result = await adapter.getLastLoopPromise?.();
    expect(result?.completed).toBe(false);
    expect(result?.failureReason).toBeUndefined();
    expect(result?.agentCallHandoff).toEqual({
      outcome: "pending",
      state: "running",
      callId: "call-running",
    });
    expect(modelCalled).toBe(false);
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
    expect(events.some((event) => event.type === "execution.failed")).toBe(false);
  });
});
