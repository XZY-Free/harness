import type { ExecutionBinding, Invocation } from "@/lib/persistence/schema/executions";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/runtimes";
import { buildCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { describe, expect, it, vi } from "vitest";
import { createResumeHarnessInvocation } from "./resume-harness-invocation";

describe("External Runtime continuation resume", () => {
  it("复用原 Invocation、Binding 和 source version，不新建 Invocation", async () => {
    const catalog = buildCapabilityCatalogSnapshot({
      invocationId: "invocation-external",
      preferredAgentId: null,
      agentCandidate: null,
      tools: [],
      knowledgeSources: [],
      sourceRefs: [],
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const invocation = {
      id: "invocation-external",
      tenantId: "tenant-1",
      executionState: "running",
    } as Invocation;
    const binding = {
      invocationId: invocation.id,
      tenantId: "tenant-1",
      runtimeRevisionId: "runtime-revision-external",
      runtimeEvidenceKind: "external_endpoint",
      runtimeTargetDigest: "sha256:runtime-target",
      capabilityCatalogJson: catalog.snapshot,
      capabilityCatalogDigest: catalog.digest,
      executionSubjectType: "service",
      executionSubjectId: "service-1",
      executionSubjectSource: "trusted_service",
      executionSubjectFrozenAt: new Date("2026-01-01T00:00:00Z"),
    } as ExecutionBinding;
    const resumeExternal = vi.fn(async () => ({ resumed: true }));
    const resume = createResumeHarnessInvocation({
      loadInvocation: async () => invocation,
      loadBinding: async () => binding,
      loadRuntimeRevision: async () =>
        ({
          id: binding.runtimeRevisionId,
          endpointRef: "https://runtime.example",
          runtimeEvidenceKind: "external_endpoint",
          runtimeTargetDigest: "sha256:runtime-target",
          protocolType: "harness_runtime_protocol",
        }) as RuntimeRevisionRow,
      acquireLease: async () => ({ id: "lease-1" }),
      releaseLease: vi.fn(async () => undefined),
      renewLease: vi.fn(async () => true),
      runHosted: vi.fn(),
      resumeExternal,
    });

    await expect(
      resume({
        tenantId: "tenant-1",
        invocationId: invocation.id,
        agentCallId: "call-1",
        sourceVersion: 4,
      }),
    ).resolves.toMatchObject({ runtime: "external", invocationId: invocation.id });
    expect(resumeExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ id: invocation.id }),
        binding: expect.objectContaining({ invocationId: invocation.id }),
        agentCallId: "call-1",
        sourceVersion: 4,
      }),
    );
    await expect(
      resume({
        tenantId: "tenant-1",
        invocationId: invocation.id,
        sourceType: "tool_call",
        agentCallId: "tool-call-1",
        sourceVersion: 1,
      }),
    ).resolves.toMatchObject({ runtime: "external", invocationId: invocation.id });
    expect(resumeExternal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceType: "tool_call",
        agentCallId: "tool-call-1",
        sourceVersion: 1,
      }),
    );
  });
});
