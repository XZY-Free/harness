/**
 * External Runtime 的 Parent resume 必须经**同一** Start 服务（`runtime-resume`）进入。
 *
 * 冻结不变量（R02 §7）：
 * - resume 复用原 Invocation 与 Binding，只按 invocationId 加载，不新建 Invocation；
 * - External 分支**不**自造临时 idempotency key：它调用 `resumeRuntimeInvocation`
 *   （→ `startRuntimeInvocation`，`intentType=resume`），由 Session 冻结稳定启动意图；
 * - Hosted Loop 只服务 hosted_artifact Binding，外部 Binding 不得走 in-process 路径。
 */
import type { ExecutionBinding, Invocation } from "@/lib/persistence/schema/executions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInvocationById: vi.fn(),
  getExecutionBindingByInvocation: vi.fn(),
  getAttemptById: vi.fn(),
  getLatestAttempt: vi.fn(),
  getRuntimeRevisionById: vi.fn(),
  startRuntimeInvocation: vi.fn(),
  resolveOutboundRuntimeAuth: vi.fn(),
  createHttpHarnessRuntimeTransport: vi.fn(),
}));

vi.mock("@/lib/executions/persistence/invocation-store", () => ({
  getInvocationById: mocks.getInvocationById,
  getAttemptById: mocks.getAttemptById,
}));
vi.mock("@/lib/executions/persistence/attempt-store", () => ({
  getAttemptById: mocks.getAttemptById,
  getLatestAttempt: mocks.getLatestAttempt,
}));
vi.mock("@/lib/executions/persistence/execution-binding-queries", () => ({
  getExecutionBindingByInvocation: mocks.getExecutionBindingByInvocation,
}));
vi.mock("@/lib/executions/persistence/execution-ownership-store", () => ({
  getActiveExecutionOwnership: vi.fn(),
  renewExecutionOwnership: vi.fn(),
  closeExecutionOwnership: vi.fn(),
  acquireExecutionOwnership: vi.fn(),
}));
vi.mock("@/lib/runtime/persistence/runtime-session-store", () => ({
  getRuntimeSessionBindingByOwnership: vi.fn(),
  createRuntimeSessionBindingInTransaction: vi.fn(),
  updateRuntimeSessionDispatchInTransaction: vi.fn(),
  markRuntimeSessionLostByOwnershipInTransaction: vi.fn(),
  markRuntimeSessionLostInTransaction: vi.fn(),
}));
vi.mock("@/lib/runtime/persistence/runtime-revision-queries", () => ({
  getRuntimeRevisionById: mocks.getRuntimeRevisionById,
}));
vi.mock("@/lib/runtime/credentials/resolve-outbound-runtime-auth", () => ({
  resolveOutboundRuntimeAuth: mocks.resolveOutboundRuntimeAuth,
}));
vi.mock("@/lib/runtime/transport/http-harness-runtime-transport", () => ({
  createHttpHarnessRuntimeTransport: mocks.createHttpHarnessRuntimeTransport,
}));
vi.mock("@/lib/runtime/application/runtime-start", () => ({
  startRuntimeInvocation: mocks.startRuntimeInvocation,
  buildExecutionCredentials: vi.fn(),
}));
vi.mock("@/lib/runtime/adapters/hosted-adapter", () => ({
  HostedHarnessLoop: class {
    run = vi.fn();
  },
}));

import { resumeHarnessInvocation, type resumeRuntimeInvocation } from "./runtime-resume";

const invocation = {
  id: "invocation-external",
  tenantId: "tenant-1",
  executionState: "waiting_user",
  threadId: "thread-1",
  turnId: "turn-1",
  triggerItemId: null,
  lastProducerSequence: 1,
  recoveryVersion: 2,
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

const attempt = {
  id: "attempt-1",
  invocationId: "invocation-external",
  tenantId: "tenant-1",
  attemptState: "suspended",
  filesystemCheckpointId: null,
  resumeAnchorDigest: null,
} as unknown as Parameters<typeof resumeRuntimeInvocation>[0]["attempt"];

describe("External Runtime continuation resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInvocationById.mockResolvedValue(invocation);
    mocks.getExecutionBindingByInvocation.mockResolvedValue(binding);
    mocks.getAttemptById.mockResolvedValue(attempt);
    mocks.getLatestAttempt.mockResolvedValue(attempt);
    mocks.getRuntimeRevisionById.mockResolvedValue({
      id: "runtime-revision-external",
      tenantId: "tenant-1",
      runtimeEvidenceKind: "external_endpoint",
      endpointRef: "https://runtime.test",
      identityMode: "none",
      credentialRefId: null,
    });
    mocks.resolveOutboundRuntimeAuth.mockResolvedValue({ mode: "none" });
    mocks.createHttpHarnessRuntimeTransport.mockReturnValue({ kind: "external-http-transport" });
    mocks.startRuntimeInvocation.mockResolvedValue({
      authority: { ownershipId: "ownership-1" },
      response: { acceptedAt: new Date().toISOString() },
      sessionBindingId: "session-1",
    });
  });

  it("复用原 Invocation/Binding，并经同一 Start 服务（intentType=resume）进入", async () => {
    const result = await resumeHarnessInvocation({
      tenantId: "tenant-1",
      invocationId: "invocation-external",
      agentCallId: "call-1",
      sourceVersion: 4,
    });
    expect(result).toMatchObject({
      status: "resumed",
      invocationId: "invocation-external",
      runtime: "external",
    });
    // 只按 durable identity 加载同一 Invocation/Binding；resume 全程无新建 Invocation。
    expect(mocks.getInvocationById).toHaveBeenCalledWith("tenant-1", "invocation-external");
    expect(mocks.getExecutionBindingByInvocation).toHaveBeenCalledWith(
      "tenant-1",
      "invocation-external",
    );
    // 进入同一 Start 服务：存在 suspended Attempt + external transport + intentType=resume。
    expect(mocks.startRuntimeInvocation).toHaveBeenCalledTimes(1);
    const started = mocks.startRuntimeInvocation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(started).toMatchObject({
      tenantId: "tenant-1",
      invocation: expect.objectContaining({ id: "invocation-external" }),
      binding: expect.objectContaining({ invocationId: "invocation-external" }),
      attempt: expect.objectContaining({ id: "attempt-1", attemptState: "suspended" }),
      intentType: "resume",
      recovery: expect.objectContaining({ kind: "resume" }),
    });
    // transport 由 revision 端点构造，不是 in-process Hosted Loop。
    expect(mocks.createHttpHarnessRuntimeTransport).toHaveBeenCalledWith({
      endpoint: "https://runtime.test",
      auth: { mode: "none" },
    });
    expect(started.runtimeClient).toEqual({ kind: "external-http-transport" });
    // External 回调端点按 invocationId 解析，不是 in-process Hosted 通道。
    expect(started.callbackEndpoints).toMatchObject({
      events: expect.stringContaining("/runtime/invocations/invocation-external/events"),
      heartbeat: expect.stringContaining("/runtime/invocations/invocation-external/heartbeat"),
    });
  });

  it("终态 Attempt 直接拒绝，不构造任何外部请求", async () => {
    mocks.getLatestAttempt.mockResolvedValue({ ...attempt, attemptState: "lost" });
    await expect(
      resumeHarnessInvocation({
        tenantId: "tenant-1",
        invocationId: "invocation-external",
        agentCallId: "call-2",
        sourceVersion: 1,
      }),
    ).rejects.toThrow("AttemptMismatch");
    expect(mocks.createHttpHarnessRuntimeTransport).not.toHaveBeenCalled();
    expect(mocks.startRuntimeInvocation).not.toHaveBeenCalled();
  });
});
