import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import type { RuntimeStartRequest } from "@/lib/runtime/runtime-protocol";
import { TrustedExecutionSubjectError } from "@/lib/runtime/transport/execution-subject";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invocationId = "00000000-0000-4000-8000-000000000011";
const authority = {
  invocationId,
  runtimeRevisionId: "00000000-0000-4000-8000-000000000012",
  attemptId: "00000000-0000-4000-8000-000000000013",
  ownershipId: "00000000-0000-4000-8000-000000000014",
  leaseEpoch: "1",
  sessionBindingId: "00000000-0000-4000-8000-000000000015",
} as const;
const digest = `sha256:${"0".repeat(64)}`;
// R02 §3：Hosted 接纳回执的摘要来自冻结发布证据（与请求的 runtimeRevisionId 一致）。
const frozenCapabilityEvidence = {
  runtimeRevisionId: authority.runtimeRevisionId,
  runtimeCapabilitiesJson: ["event_stream"],
};

function request(): RuntimeStartRequest {
  const now = Date.now();
  return {
    protocolVersion: 3,
    authority,
    intentType: "start",
    semanticRequestDigest: digest,
    executionBinding: {
      bindingDigest: digest,
      runtimeRevisionId: authority.runtimeRevisionId,
      policyRefs: [authority.runtimeRevisionId],
      governanceRefs: [authority.runtimeRevisionId],
      capabilityRefs: [authority.runtimeRevisionId],
      modelRefs: [],
      allowedEgress: [],
    },
    context: {
      common: {
        contractVersion: 1,
        tenantId: invocationId,
        invocationId,
        bindingDigest: digest,
        initialCompression: null,
        principal: { type: "service", id: "test", source: "trusted_service" },
        runtimeRevisionId: authority.runtimeRevisionId,
        policy: { revisionId: authority.runtimeRevisionId, digest },
        workspace: { bindingId: authority.attemptId, contractDigest: digest },
        environment: { mode: "NO_PLATFORM_ENVIRONMENT" },
        contextSourceDigest: digest,
        issuedAt: now,
        expiresAt: now + 60_000,
        jti: authority.sessionBindingId,
      },
      subject: {
        type: "job",
        jobId: invocationId,
        inputKind: "inline",
        inputHash: digest,
        triggerRef: "integration-test",
      },
    },
    inputs: [{ kind: "inline", digest }],
    environment: { mode: "NO_PLATFORM_ENVIRONMENT" },
    workspace: { mode: "NONE" },
    activationDigest: digest,
    recovery: { kind: "initial" },
    producerSequenceStart: "1",
    callbackEndpoints: {
      events: "https://test.invalid/events",
      heartbeat: "https://test.invalid/heartbeat",
      context: "https://test.invalid/context",
      capabilityActions: "https://test.invalid/capability-actions",
      toolCalls: "https://test.invalid/tool-calls",
      userActions: "https://test.invalid/user-actions",
    },
    credentials: {
      runtimeToken: "runtime-token",
      gatewayToken: "gateway-token",
      expiresAt: now + 60_000,
    },
    executionLimits: {
      maxEventBytes: 1024,
      maxBatchEvents: 10,
      maxBatchBytes: 8192,
      dispatchDeadlineMs: 60_000,
      executionTimeoutMs: 60_000,
    },
  };
}

describe("runtime dispatch trusted subject", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("trusted subject 缺失时在 dispatch 前失败", async () => {
    await expect(
      (dispatchInvocationForTurn as unknown as (input: unknown) => Promise<unknown>)({
        tenantId: "tenant-a",
        turnId: "turn-a",
      }),
    ).rejects.toBeInstanceOf(TrustedExecutionSubjectError);
    expect(await db.select().from(invocationTable)).toHaveLength(0);
    expect(await db.select().from(executionBindingTable)).toHaveLength(0);
  });

  it("R02 §2：Hosted launch 向 application service 转交准确的 authority 与 Session 启动身份", async () => {
    const start = vi.fn(async ({ invocationId: value }: { invocationId: string }) => ({
      status: "resumed" as const,
      invocationId: value,
      runtime: "hosted" as const,
    }));
    const client = createInProcessHostedRuntimeClient({
      tenantId: invocationId,
      publishedCapabilityEvidence: frozenCapabilityEvidence,
      applicationService: { start, resume: vi.fn(), cancel: vi.fn(), steer: vi.fn() },
    });
    await client.startInvocation({
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "runtime-token" },
      idempotencyKey: `start:${authority.ownershipId}`,
      request: request(),
    });

    // 应用层拿到的是 Start 请求里的完整 authority（含 Attempt/Ownership/epoch/Session），
    // 而不是只有 invocationId——运行期据此复核代际，不按 invocationId 跟随 current。
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: invocationId,
        invocationId,
        idempotencyKey: `start:${authority.ownershipId}`,
        authority: expect.objectContaining({
          invocationId,
          attemptId: authority.attemptId,
          ownershipId: authority.ownershipId,
          leaseEpoch: authority.leaseEpoch,
          sessionBindingId: authority.sessionBindingId,
          runtimeRevisionId: authority.runtimeRevisionId,
        }),
      }),
    );
  });
});
