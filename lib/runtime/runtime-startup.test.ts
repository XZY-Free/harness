import {
  type RuntimeStartRequest,
  buildStartSemanticDigestInput,
  computeSemanticRequestDigest,
} from "@/lib/runtime/runtime-protocol";
import { describe, expect, it } from "vitest";

const digest = `sha256:${"a".repeat(64)}`;
const request = {
  protocolVersion: 3,
  authority: {
    invocationId: "11111111-1111-4111-8111-111111111111",
    runtimeRevisionId: "22222222-2222-4222-8222-222222222222",
    attemptId: "33333333-3333-4333-8333-333333333333",
    ownershipId: "44444444-4444-4444-8444-444444444444",
    leaseEpoch: "1",
    sessionBindingId: "55555555-5555-4555-8555-555555555555",
  },
  intentType: "start",
  semanticRequestDigest: digest,
  executionBinding: {
    bindingDigest: digest,
    runtimeRevisionId: "22222222-2222-4222-8222-222222222222",
    policyRefs: [],
    governanceRefs: [],
    capabilityRefs: [],
    modelRefs: [],
    allowedEgress: [],
  },
  context: {
    common: {
      contractVersion: 1,
      tenantId: "66666666-6666-4666-8666-666666666666",
      invocationId: "11111111-1111-4111-8111-111111111111",
      bindingDigest: digest,
      principal: { type: "service", id: "dispatch", source: "trusted_service" },
      runtimeRevisionId: "22222222-2222-4222-8222-222222222222",
      policy: { revisionId: "77777777-7777-4777-8777-777777777777", digest },
      workspace: { bindingId: "88888888-8888-4888-8888-888888888888", contractDigest: digest },
      environment: { mode: "NO_PLATFORM_ENVIRONMENT" },
      contextSourceDigest: digest,
      issuedAt: 1,
      expiresAt: 2,
      jti: "99999999-9999-4999-8999-999999999999",
    },
    subject: {
      type: "job",
      jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      inputKind: "inline",
      inputHash: digest,
      triggerRef: "schedule:startup",
    },
  },
  inputs: [{ kind: "persistent_ref", ref: "job:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", digest }],
  environment: { mode: "NO_PLATFORM_ENVIRONMENT" },
  workspace: { mode: "NONE" },
  activationDigest: digest,
  recovery: { kind: "initial" },
  producerSequenceStart: "1",
  callbackEndpoints: {
    events: "https://platform.example/runtime/invocations/x/events",
    heartbeat: "https://platform.example/runtime/invocations/x/heartbeat",
    context: "https://platform.example/gateway/context/query",
    capabilityActions: "https://platform.example/gateway/capability-actions",
    toolCalls: "https://platform.example/gateway/tool-calls",
    userActions: "https://platform.example/gateway/user-action-requests",
  },
  credentials: { runtimeToken: "runtime-token", gatewayToken: "gateway-token", expiresAt: 3 },
  executionLimits: {
    maxEventBytes: 1,
    maxBatchEvents: 1,
    maxBatchBytes: 1,
    dispatchDeadlineMs: 1,
    executionTimeoutMs: 1,
  },
} as const satisfies RuntimeStartRequest;

describe("Runtime startup canonical persistence", () => {
  it("freezes only semantic request facts and excludes renewable credentials", () => {
    const semantic = buildStartSemanticDigestInput(request);
    expect(semantic).not.toHaveProperty("credentials");
    expect(semantic).not.toHaveProperty("semanticRequestDigest");
    expect(computeSemanticRequestDigest(request)).toBe(
      computeSemanticRequestDigest({
        ...request,
        credentials: { ...request.credentials, runtimeToken: "rotated" },
      }),
    );
  });
});
