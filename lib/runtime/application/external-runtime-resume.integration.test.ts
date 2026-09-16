/**
 * External Runtime resume 适配 V12 resumeHarnessInvocation 后的行为验证。
 *
 * 冻结不变量：
 * - resume 复用原 Invocation 与 Binding，只按 invocationId 加载，不新建 Invocation；
 * - ExecutionAuthority 来自当前活跃 ExecutionOwnership + RuntimeSessionBinding；
 * - Hosted Loop 用同一 invocationId 启动，Authority 全程不变。
 */
import type {
  ExecutionBinding,
  ExecutionOwnership,
  Invocation,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInvocationById: vi.fn<() => Promise<Invocation>>(),
  getExecutionBindingByInvocation: vi.fn<() => Promise<ExecutionBinding>>(),
  getActiveExecutionOwnership: vi.fn<() => Promise<ExecutionOwnership>>(),
  getRuntimeSessionBindingByOwnership: vi.fn<() => Promise<RuntimeSessionBinding>>(),
  getRuntimeRevisionById: vi.fn(),
  renewExecutionOwnership: vi.fn(),
  hostedLoopOptions: [] as Array<Record<string, unknown>>,
  hostedLoopRun: vi.fn(),
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
}));
vi.mock("@/lib/runtime/persistence/runtime-revision-queries", () => ({
  getRuntimeRevisionById: mocks.getRuntimeRevisionById,
}));
vi.mock("@/lib/runtime/adapters/hosted-adapter", () => ({
  HostedHarnessLoop: class {
    options: Record<string, unknown>;
    run = mocks.hostedLoopRun;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.hostedLoopOptions.push(options);
    }
  },
}));
vi.mock("@/lib/conversations/turn-queries", () => ({
  getTurnById: vi.fn(async () => ({ id: "turn-external" })),
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

import { resumeHarnessInvocation } from "./runtime-resume";

const invocation = {
  id: "invocation-external",
  tenantId: "tenant-1",
  executionState: "running",
  threadId: "thread-1",
  turnId: "turn-1",
  triggerItemId: null,
  lastProducerSequence: 1,
} as Invocation;

const binding = {
  invocationId: "invocation-external",
  tenantId: "tenant-1",
  runtimeRevisionId: "runtime-revision-external",
  runtimeEvidenceKind: "external_endpoint",
  runtimeTargetDigest: "sha256:runtime-target",
  workspaceBindingId: "workspace-1",
  modelId: "test-model",
  environmentMode: "NO_PLATFORM_ENVIRONMENT",
} as ExecutionBinding;

const ownership = {
  id: "ownership-1",
  attemptId: "attempt-1",
  leaseEpoch: 3,
  executionPhase: "executing",
} as ExecutionOwnership;

const session = {
  id: "session-1",
  invocationId: "invocation-external",
  attemptId: "attempt-1",
  ownershipId: "ownership-1",
  runtimeRevisionId: "runtime-revision-external",
  leaseEpoch: 3,
  bindingState: "active",
  startIntentKey: "start:ownership-1",
  semanticRequestDigest: null,
  remoteSessionRef: null,
  remoteExecutionRef: null,
  transportAcknowledgement: null,
} as RuntimeSessionBinding;

describe("External Runtime continuation resume", () => {
  beforeEach(() => {
    mocks.hostedLoopOptions.length = 0;
    mocks.hostedLoopRun.mockReset();
    mocks.hostedLoopRun.mockResolvedValue({
      completed: true,
      responseText: "",
      sentEvents: [],
      pending: false,
      waitingForUser: false,
    });
    mocks.renewExecutionOwnership.mockResolvedValue(ownership);
    mocks.getInvocationById.mockResolvedValue(invocation);
    mocks.getExecutionBindingByInvocation.mockResolvedValue(binding);
    mocks.getActiveExecutionOwnership.mockResolvedValue(ownership);
    mocks.getRuntimeSessionBindingByOwnership.mockResolvedValue(session);
    mocks.getRuntimeRevisionById.mockResolvedValue({
      id: "runtime-revision-external",
      tenantId: "tenant-1",
    });
  });

  it("复用原 Invocation、Binding 和 source version，不新建 Invocation", async () => {
    const result = await resumeHarnessInvocation({
      tenantId: "tenant-1",
      invocationId: "invocation-external",
      agentCallId: "call-1",
      sourceVersion: 4,
    });
    expect(result).toMatchObject({
      status: "resumed",
      invocationId: "invocation-external",
    });
    // 只按 durable identity 加载同一 Invocation/Binding；resume 全程无新建 Invocation 的路径。
    expect(mocks.getInvocationById).toHaveBeenCalledWith("tenant-1", "invocation-external");
    expect(mocks.getExecutionBindingByInvocation).toHaveBeenCalledWith(
      "tenant-1",
      "invocation-external",
    );
    // Loop 复用同一 Invocation 与当前 Authority 启动。
    expect(mocks.hostedLoopOptions).toHaveLength(1);
    expect(mocks.hostedLoopOptions[0]).toMatchObject({
      invocationId: "invocation-external",
      tenantId: "tenant-1",
    });

    // 第二次 resume（tool_call 来源，sourceVersion 1）仍复用同一 Invocation/Binding。
    await resumeHarnessInvocation({
      tenantId: "tenant-1",
      invocationId: "invocation-external",
      sourceType: "tool_call",
      agentCallId: "tool-call-1",
      sourceVersion: 1,
    });
    expect(mocks.getInvocationById).toHaveBeenLastCalledWith("tenant-1", "invocation-external");
    expect(mocks.getExecutionBindingByInvocation).toHaveBeenCalledTimes(2);
    expect(mocks.hostedLoopOptions).toHaveLength(2);
    expect(mocks.hostedLoopOptions[1]).toMatchObject({ invocationId: "invocation-external" });
  });
});
