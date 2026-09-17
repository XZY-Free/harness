/**
 * Resume Harness Invocation（V12 resumeHarnessInvocation）行为测试。
 *
 * V12 变化：旧 createResumeHarnessInvocation 的可注入租约工厂已被
 * ExecutionOwnership 执行权模型取代——活跃 Owner 即唯一执行权凭证，
 * resume 复用当前 Owner/SessionBinding 的 Authority 启动 Hosted Loop。
 * 本文件按当前 API 保留原有场景语义：
 * - 单执行器：新鲜 Owner 存活时启动 Loop；Owner 释放后 resume 被拒绝；
 * - 父 Invocation 终态 → handled_noop，不触碰执行权；
 * - user_pause 来源恢复 waiting_user 快照；
 * - Owner 续约失败 → 向 Loop 发出 fail-closed 中止信号。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ExecutionBinding,
  ExecutionOwnership,
  Invocation,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInvocationById: vi.fn<() => Promise<Invocation>>(),
  getExecutionBindingByInvocation: vi.fn<() => Promise<ExecutionBinding>>(),
  getActiveExecutionOwnership: vi.fn<() => Promise<ExecutionOwnership>>(),
  getRuntimeSessionBindingByOwnership: vi.fn<() => Promise<RuntimeSessionBinding>>(),
  getRuntimeSessionBindingById: vi.fn<() => Promise<RuntimeSessionBinding>>(),
  getRuntimeRevisionById: vi.fn(),
  renewExecutionOwnership: vi.fn<() => Promise<ExecutionOwnership>>(),
  hostedLoopOptions: [] as Array<Record<string, unknown>>,
  hostedLoopResult: {
    completed: true,
    responseText: "完成",
    sentEvents: [],
    pending: false,
    waitingForUser: false,
  },
  hostedLoopResolveOnAbort: false,
}));

vi.mock("@/lib/executions/persistence/invocation-store", () => ({
  getInvocationById: mocks.getInvocationById,
  getAttemptById: vi.fn(),
}));
vi.mock("@/lib/executions/persistence/execution-binding-queries", () => ({
  getExecutionBindingByInvocation: mocks.getExecutionBindingByInvocation,
}));
vi.mock("@/lib/executions/persistence/execution-ownership-store", () => ({
  getActiveExecutionOwnership: mocks.getActiveExecutionOwnership,
  renewExecutionOwnership: mocks.renewExecutionOwnership,
  closeExecutionOwnership: vi.fn(),
}));
vi.mock("@/lib/runtime/persistence/runtime-session-store", () => ({
  getRuntimeSessionBindingByOwnership: mocks.getRuntimeSessionBindingByOwnership,
  getRuntimeSessionBindingById: mocks.getRuntimeSessionBindingById,
}));
vi.mock("@/lib/runtime/persistence/runtime-revision-queries", () => ({
  getRuntimeRevisionById: mocks.getRuntimeRevisionById,
}));
vi.mock("@/lib/runtime/adapters/hosted-adapter", () => ({
  HostedHarnessLoop: class {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.hostedLoopOptions.push(options);
    }
    run() {
      if (mocks.hostedLoopResolveOnAbort) {
        return new Promise<{ completed: boolean; responseText: string; sentEvents: [] }>(
          (resolve) => {
            const signal = (this.options as { abortSignal: AbortSignal }).abortSignal;
            signal.addEventListener(
              "abort",
              () =>
                resolve({
                  completed: false,
                  responseText: "",
                  sentEvents: [],
                }),
              { once: true },
            );
          },
        );
      }
      return Promise.resolve(mocks.hostedLoopResult);
    }
  },
}));
vi.mock("@/lib/conversations/turn-queries", () => ({
  getTurnById: vi.fn(async () => ({ id: "turn-1" })),
}));
vi.mock("@/lib/workspace/workspace-queries", () => ({
  getWorkspaceBindingById: vi.fn(async () => ({
    id: "workspace-1",
    continuityMode: "NO_PLATFORM_WORKSPACE",
    contractDigest: `sha256:${"0".repeat(64)}`,
  })),
}));
vi.mock("@/lib/runtime/harness-loop/configured-model-ports", () => ({
  configuredDecisionPort: vi.fn(() => ({ decideNextAction: async () => null })),
  configuredFinalResponsePort: vi.fn(() => ({ generateFinalResponse: async () => "" })),
}));
vi.mock("@/lib/runtime/harness-loop/mysql-recovery-port", () => ({
  createMySqlHarnessLoopRecoveryPort: vi.fn(() => ({ load: async () => null })),
}));

import { frozenCapabilityCatalogForInvocation } from "@/lib/test-support/frozen-capability-catalog";
import { resumeHarnessInvocation } from "./runtime-resume";

function fixture(executionState: Invocation["executionState"]) {
  const invocation = {
    id: "invocation-1",
    tenantId: "tenant-1",
    executionState,
    threadId: "thread-1",
    turnId: "turn-1",
    triggerItemId: null,
    lastProducerSequence: 1,
  } as Invocation;
  const binding = {
    invocationId: "invocation-1",
    tenantId: "tenant-1",
    runtimeRevisionId: "runtime-revision-1",
    runtimeEvidenceKind: "hosted_artifact",
    runtimeTargetDigest: "sha256:runtime-target",
    workspaceBindingId: "workspace-1",
    modelId: "test-model",
    environmentMode: "NO_PLATFORM_ENVIRONMENT",
    // R01 §1：执行主体必须来自 Binding 冻结的可信 principal 事实。
    principalType: "user",
    principalId: "user-1",
    principalSource: "authenticated_user",
    principalFrozenAt: new Date(0),
    // R01 §5：Hosted 执行必须从 Binding 冻结的能力目录装配，夹具给出一份可重验的空目录。
    ...frozenCapabilityCatalogForInvocation("invocation-1"),
  } as ExecutionBinding;
  const ownership = {
    id: "ownership-1",
    attemptId: "attempt-1",
    leaseEpoch: 1,
    executionPhase: "executing",
  } as ExecutionOwnership;
  const session = {
    id: "session-1",
    invocationId: "invocation-1",
    attemptId: "attempt-1",
    ownershipId: "ownership-1",
    runtimeRevisionId: "runtime-revision-1",
    leaseEpoch: 1,
    bindingState: "active",
    startIntentKey: "start:ownership-1",
    semanticRequestDigest: null,
    remoteSessionRef: null,
    remoteExecutionRef: null,
    transportAcknowledgement: null,
  } as RuntimeSessionBinding;
  return { invocation, binding, ownership, session };
}

function stubAuthority(f: ReturnType<typeof fixture>) {
  mocks.getInvocationById.mockResolvedValue(f.invocation);
  mocks.getExecutionBindingByInvocation.mockResolvedValue(f.binding);
  mocks.getActiveExecutionOwnership.mockResolvedValue(f.ownership);
  mocks.getRuntimeSessionBindingByOwnership.mockResolvedValue(f.session);
  mocks.getRuntimeSessionBindingById.mockResolvedValue(f.session);
  mocks.getRuntimeRevisionById.mockResolvedValue({
    id: "runtime-revision-1",
    tenantId: "tenant-1",
    runtimeEvidenceKind: "hosted_artifact",
  });
  mocks.renewExecutionOwnership.mockResolvedValue(f.ownership);
}

/**
 * R02 §2：Hosted 分支必须携带 Start/Resume 的准确 authority —— 测试从夹具的
 * Owner/Session 事实推导，手工抄字段会在代际变更时静默失真。
 */
function authorityOf(f: ReturnType<typeof fixture>) {
  return {
    invocationId: f.invocation.id,
    runtimeRevisionId: f.binding.runtimeRevisionId,
    attemptId: f.ownership.attemptId,
    ownershipId: f.ownership.id,
    leaseEpoch: String(f.ownership.leaseEpoch),
    sessionBindingId: f.session.id,
  };
}

beforeEach(() => {
  mocks.hostedLoopOptions.length = 0;
  mocks.hostedLoopResolveOnAbort = false;
  mocks.hostedLoopResult = {
    completed: true,
    responseText: "完成",
    sentEvents: [],
    pending: false,
    waitingForUser: false,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Resume Harness Invocation", () => {
  it("重复 resume 只能有一个执行器：活跃 Owner 存活时启动 Loop，释放后拒绝重入", async () => {
    const f = fixture("running");
    stubAuthority(f);

    const first = await resumeHarnessInvocation({
      tenantId: "tenant-1",
      invocationId: "invocation-1",
      agentCallId: "call-1",
      sourceVersion: 2,
      authority: authorityOf(f),
    });
    expect(first).toMatchObject({ status: "resumed", completed: true });
    expect(mocks.hostedLoopOptions).toHaveLength(1);

    // Owner 已释放（无活跃 ExecutionOwnership）→ 同一 Invocation 不能再次取得执行权。
    mocks.getActiveExecutionOwnership.mockResolvedValue(null as unknown as ExecutionOwnership);
    await expect(
      resumeHarnessInvocation({
        tenantId: "tenant-1",
        invocationId: "invocation-1",
        sourceType: "user_action",
        agentCallId: "uar-1",
        sourceVersion: 1,
        authority: authorityOf(f),
      }),
    ).rejects.toThrow("NotCurrentExecutor");
    expect(mocks.hostedLoopOptions).toHaveLength(1);
  });

  it("父 Invocation 已终态时 handled-no-op，不重新获取执行权", async () => {
    const f = fixture("completed");
    mocks.getInvocationById.mockResolvedValue(f.invocation);
    const getOwnership = vi.fn();
    mocks.getActiveExecutionOwnership.mockImplementation(getOwnership);

    await expect(
      resumeHarnessInvocation({
        tenantId: "tenant-1",
        invocationId: "invocation-1",
        agentCallId: "call-1",
        sourceVersion: 2,
      }),
    ).resolves.toEqual({ status: "handled_noop", invocationId: "invocation-1" });
    expect(getOwnership).not.toHaveBeenCalled();
  });

  it("用户暂停后恢复 waiting_user 快照，Loop 只启动一次", async () => {
    const f = fixture("waiting_user");
    stubAuthority(f);

    await expect(
      resumeHarnessInvocation({
        tenantId: "tenant-1",
        invocationId: "invocation-1",
        sourceType: "user_pause",
        agentCallId: "resume-1",
        sourceVersion: 1,
        authority: authorityOf(f),
      }),
    ).resolves.toMatchObject({ status: "resumed", completed: true });
    expect(mocks.hostedLoopOptions).toHaveLength(1);
    expect(mocks.hostedLoopOptions[0]).toMatchObject({
      invocationId: "invocation-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("R02 §2：同一 generation 最多一个 Supervisor，重复交付不再起第二个 Loop", async () => {
    const f = fixture("running");
    stubAuthority(f);
    // 让第一个 Loop 保持存活（只在 abort 时结束），模拟长任务进行中。
    mocks.hostedLoopResolveOnAbort = true;

    const first = resumeHarnessInvocation({
      tenantId: "tenant-1",
      invocationId: "invocation-1",
      agentCallId: "call-1",
      sourceVersion: 1,
      authority: authorityOf(f),
    });
    await vi.waitFor(() => expect(mocks.hostedLoopOptions).toHaveLength(1));

    // 同一代际（同 authority）再次交付：不得起第二个 Loop，直接回答"仍在跑"。
    await expect(
      resumeHarnessInvocation({
        tenantId: "tenant-1",
        invocationId: "invocation-1",
        sourceType: "agent_call",
        agentCallId: "call-1",
        sourceVersion: 1,
        authority: authorityOf(f),
      }),
    ).resolves.toMatchObject({ status: "resumed", completed: false, pending: true });
    expect(mocks.hostedLoopOptions).toHaveLength(1);

    // 收尾：中止存活 Loop，让第一个 promise 结束后再退出用例。
    const options = mocks.hostedLoopOptions[0] as { abortSignal: AbortSignal };
    options.abortSignal.dispatchEvent(new Event("abort"));
    await expect(first).resolves.toMatchObject({ status: "resumed", completed: false });
  });

  it("执行权续约失败时向 Hosted Loop 发出 fail-closed 中止信号", async () => {
    const f = fixture("running");
    stubAuthority(f);
    mocks.hostedLoopResolveOnAbort = true;
    mocks.renewExecutionOwnership.mockRejectedValue(new Error("lease renew failed"));

    // 捕获传入 Loop 的 abortSignal，观察 fail-closed 中止原因。
    let observedReason: unknown;
    const originalPush = mocks.hostedLoopOptions.push.bind(mocks.hostedLoopOptions);
    mocks.hostedLoopOptions.push = (...items) => {
      const options = items[0] as { abortSignal: AbortSignal } | undefined;
      options?.abortSignal.addEventListener(
        "abort",
        () => {
          observedReason = options.abortSignal.reason;
        },
        { once: true },
      );
      return originalPush(...items);
    };

    vi.useFakeTimers();
    const promise = resumeHarnessInvocation({
      tenantId: "tenant-1",
      invocationId: "invocation-1",
      agentCallId: "call-1",
      sourceVersion: 1,
      authority: authorityOf(f),
    });
    // 心跳续约间隔 20s：推进时钟触发续约失败 → abort。
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toMatchObject({ status: "resumed", completed: false });
    expect(observedReason).toBeInstanceOf(Error);
    expect((observedReason as Error).message).toBe("OwnershipExpired");
  });

  it("Agent failed/cancelled 以结构化 Observation 交回 Harness，不直接完成父级", () => {
    const executor = readFileSync(
      resolve(process.cwd(), "lib/agents/calls/application/agent-action-executor.ts"),
      "utf8",
    );
    expect(executor).toContain("state: disposition.state");
    expect(executor).toContain("errorCode: normalizeTerminalCode(disposition.errorCode)");
    expect(executor).not.toContain(
      "throw new AgentActionExecutionError(\n          normalizeTerminalCode(disposition.errorCode)",
    );
  });
});
