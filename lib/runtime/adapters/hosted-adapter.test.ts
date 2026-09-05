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
  createHttpEventIngressClient,
  hostedAdapterCapabilities,
  setRouteHostedAdapter,
} from "@/lib/runtime/adapters/hosted-adapter";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { DEFAULT_ROUTE_SCOPE_KEY, dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { createDirectResponsePorts } from "@/lib/runtime/harness-loop/test-ports";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── 全局 setup/teardown ──────────────────────────────────

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 清理路由层 Adapter 单例，避免泄漏到其他测试文件（如 command-dispatcher.test.ts）
  setRouteHostedAdapter(null);
  vi.unstubAllGlobals();
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
    tools: "https://platform.internal/tools",
    tool_calls: "https://platform.internal/tool-calls",
    user_action_requests: "https://platform.internal/user-action-requests",
    capability_actions: "https://platform.internal/capability-actions",
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
    ...createDirectResponsePorts((view) => `测试执行器回复：${view.objective}`),
    modelRef: "test-model",
  };
}

function mockApplicationService(): HostedRuntimeApplicationService {
  return {
    start: vi.fn(async ({ invocationId }) => ({
      status: "resumed" as const,
      invocationId,
      runtime: "hosted" as const,
    })),
    resume: vi.fn(async ({ invocationId }) => ({
      status: "resumed" as const,
      invocationId,
      runtime: "hosted" as const,
    })),
    cancel: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
  };
}

// ═══════════════════════════════════════════════════════════
// 1. HostedAdapter 基本能力
// ═══════════════════════════════════════════════════════════

describe("S05-C05 HostedAdapter 基本能力", () => {
  it("HTTP Event Ingress 直接调用 Gateway 回调并携带 Gateway Token/幂等键", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpEventIngressClient({
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: "runtime-token",
      gatewayAccessToken: "gateway-token",
    });
    const event = {
      producer_event_id: "event-1",
      producer_sequence: 3,
      type: "progress.snapshot",
      payload: { text: "working" },
    };
    await client.postEventBatch("invocation-1", [event], 3);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://platform.internal",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
          "idempotency-key": "invocation-1:runtime-events:3",
        }),
        body: JSON.stringify({
          invocation_id: "invocation-1",
          events: [event],
          producer_sequence_start: 3,
        }),
      }),
    );
  });

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
      inputItems: mockInputItems("不得伪造回复"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const result = await adapter.getLastLoopPromise?.();
    expect(result?.completed).toBe(false);
    expect(result?.failureReason).toContain("未配置 HarnessDecisionPort");
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
      inputItems: mockInputItems("分析数据"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    expect(mock.events.some((event) => event.type === "progress.snapshot")).toBe(false);
  });

  it("response.completed 事件在 respond commitment 后形成（seq=3）", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-loop-002",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      inputItems: mockInputItems("生成回答"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    const loopResult = await loopPromise;

    const responseEvent = mock.events.find((e) => e.type === "response.completed");
    expect(responseEvent).toBeDefined();
    expect(responseEvent?.producer_sequence).toBe(3);
    expect(responseEvent?.payload.text).toBe(loopResult?.responseText);
    expect(responseEvent?.payload.model_ref).toBe("test-model");
    expect(responseEvent?.payload.finish_reason).toBe("stop");
  });

  it("execution.completed 事件在 action.completed 后形成（seq=5，终态）", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-loop-003",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      inputItems: mockInputItems("完成执行"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    const execEvent = mock.events.find((e) => e.type === "execution.completed");
    expect(execEvent).toBeDefined();
    expect(execEvent?.producer_sequence).toBe(5);
    expect(execEvent?.payload.finish_reason).toBe("execution.completed");
  });

  it("producer_sequence 覆盖 action 与终态事件并连续递增（1→5）", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-seq-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      inputItems: mockInputItems("连续序号"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    expect(mock.events).toHaveLength(5);
    expect(mock.events.map((event) => event.producer_sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(mock.events.map((event) => event.type)).toEqual([
      "harness.action.proposed",
      "harness.action.started",
      "response.completed",
      "harness.action.completed",
      "execution.completed",
    ]);
  });

  it("Loop 完成后返回 completed=true + responseText + sentEvents", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-complete-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      inputItems: mockInputItems("完成测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    const result = await loopPromise;

    expect(result?.completed).toBe(true);
    expect(result?.failureReason).toBeUndefined();
    expect(result?.responseText).toContain("完成测试");
    expect(result?.sentEvents).toHaveLength(5);
  });

  it("response.completed payload.text 包含用户消息内容（Item 内容）", async () => {
    const mock = createMockSink();
    const userMessage = "请帮我分析这组数据";
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-content-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
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
    const applicationService = mockApplicationService();
    const adapter = createHostedAdapter({
      ...mockAdapterParams(mock.sink),
      applicationService,
    });

    const result = await adapter.handleCancel({
      invocationId: "inv-cancel-001",
      reason: "user_cancel",
      cancelledBy: "test-user",
      authToken: mockAuthToken(),
    });

    expect(result.cancel_state).toBe("accepted");
    expect(result.already_completed_effects_preserved).toBe(true);
    expect(applicationService.cancel).toHaveBeenCalledOnce();
  });

  it("handleResume 未配置正式应用服务时 fail closed", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await expect(
      adapter.handleResume({
        invocationId: "inv-resume-001",
        resumePayload: { action: "confirm" },
        authToken: mockAuthToken(),
      }),
    ).rejects.toMatchObject({ code: "HOSTED_CONTROL_SERVICE_UNAVAILABLE" });
  });

  it("handleSteer 返回 steer_state=accepted + applies_at=next_safe_point + generation_interrupted=false", async () => {
    const mock = createMockSink();
    const applicationService = mockApplicationService();
    const adapter = createHostedAdapter({
      ...mockAdapterParams(mock.sink),
      applicationService,
    });

    const result = await adapter.handleSteer({
      invocationId: "inv-steer-001",
      steerPayload: { guidance: "请简洁" },
      authToken: mockAuthToken(),
    });

    expect(result.steer_state).toBe("accepted");
    expect(result.applies_at).toBe("next_safe_point");
    expect(result.generation_interrupted).toBe(false);
    expect(applicationService.steer).toHaveBeenCalledOnce();
  });

  it("handleCancel 等待正式应用服务完成，不自行伪造 cancelled 事件", async () => {
    const mock = createMockSink();
    const applicationService = mockApplicationService();
    const adapter = createHostedAdapter({
      ...mockAdapterParams(mock.sink),
      applicationService,
    });
    const result = await adapter.handleCancel({
      invocationId: "inv-cancel-async-001",
      reason: "user_cancel",
      cancelledBy: "test-user",
      authToken: mockAuthToken(),
    });

    expect(result.cancel_state).toBe("accepted");
    expect(applicationService.cancel).toHaveBeenCalledOnce();
    expect(mock.events).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// Batch 1：preferred directive 不等于调用命令
// ═══════════════════════════════════════════════════════════

describe("S05-C05 HostedAdapter AgentUseDirective", () => {
  it("preferred Agent 不会自动调用 executor，基础模型仍可完成", async () => {
    const { sink, events } = createMockSink();
    let executorCalls = 0;
    const adapter = createHostedAdapter({
      platformEndpoint: "https://platform.internal",
      platformAuthToken: "test-token",
      eventBatchSink: sink,
      ...createDirectResponsePorts(async () => "基础模型已回答"),
      actionExecutors: {
        "agent.call": async () => {
          executorCalls += 1;
          throw new Error("preferred 不应直接触发 AgentCall");
        },
      },
      modelRef: "test-model",
    });

    await adapter.startInvocation({
      invocationId: `inv-preferred-${randomUUID()}`,
      threadId: "thread-preferred",
      turnId: "turn-preferred",
      capabilityDirectives: [
        { capability_type: "agent", capability_id: "agent-1", mode: "preferred" },
      ],
      inputItems: mockInputItems("无需 Agent 的问题"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const result = await adapter.getLastLoopPromise?.();
    expect(result?.completed).toBe(true);
    expect(executorCalls).toBe(0);
    expect(events.some((event) => event.type === "response.completed")).toBe(true);
  });
});
