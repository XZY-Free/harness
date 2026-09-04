import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExecutionBinding, Invocation } from "@/lib/persistence/schema/executions";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/runtimes";
import { buildCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { describe, expect, it, vi } from "vitest";
import { createResumeHarnessInvocation } from "./resume-harness-invocation";

function fixture(runtimeEvidenceKind: "hosted_artifact" | "external_endpoint" = "hosted_artifact") {
  const catalog = buildCapabilityCatalogSnapshot({
    invocationId: "invocation-1",
    preferredAgentId: null,
    agentCandidate: null,
    tools: [],
    knowledgeSources: [],
    sourceRefs: ["route:1"],
    now: new Date("2026-01-01T00:00:00Z"),
  });
  const invocation = {
    id: "invocation-1",
    tenantId: "tenant-1",
    executionState: "running",
  } as Invocation;
  const binding = {
    invocationId: invocation.id,
    tenantId: invocation.tenantId,
    runtimeRevisionId: "runtime-revision-1",
    runtimeEvidenceKind,
    runtimeTargetDigest: "sha256:runtime-target",
    capabilityCatalogJson: catalog.snapshot,
    capabilityCatalogDigest: catalog.digest,
    executionSubjectType: "user",
    executionSubjectId: "user-1",
    executionSubjectSource: "authenticated_user",
    executionSubjectFrozenAt: new Date("2026-01-01T00:00:00Z"),
  } as ExecutionBinding;
  const runtimeRevision = {
    id: "runtime-revision-1",
    endpointRef: runtimeEvidenceKind === "external_endpoint" ? "https://runtime.example" : "",
    runtimeEvidenceKind,
    runtimeTargetDigest: "sha256:runtime-target",
    protocolType: "harness_runtime_protocol",
  } as RuntimeRevisionRow;
  return { invocation, binding, runtimeRevision };
}

describe("Resume Harness Invocation", () => {
  it("恢复 frozen subject/catalog，持有租约并继续同一 Hosted Invocation", async () => {
    const f = fixture();
    const runHosted = vi.fn(async () => ({
      completed: true,
      responseText: "完成",
      sentEvents: [],
    }));
    const releaseLease = vi.fn(async () => undefined);
    const resume = createResumeHarnessInvocation({
      loadInvocation: async () => f.invocation,
      loadBinding: async () => f.binding,
      loadRuntimeRevision: async () => f.runtimeRevision,
      acquireLease: async () => ({ id: "lease-1" }),
      releaseLease,
      renewLease: vi.fn(async () => true),
      runHosted,
      resumeExternal: vi.fn(),
    });

    const result = await resume({
      tenantId: "tenant-1",
      invocationId: "invocation-1",
      agentCallId: "call-1",
      sourceVersion: 2,
    });

    expect(result).toMatchObject({
      status: "resumed",
      invocationId: "invocation-1",
      runtime: "hosted",
      completed: true,
    });
    expect(runHosted).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.objectContaining({ tenantId: "tenant-1", subjectId: "user-1" }),
        capabilityCatalog: expect.objectContaining({ invocationId: "invocation-1" }),
      }),
    );
    expect(releaseLease).toHaveBeenCalledWith({ invocationId: "invocation-1", leaseId: "lease-1" });
  });

  it("父 Invocation 已终态时 handled-no-op，不重新获取租约", async () => {
    const f = fixture();
    f.invocation.executionState = "completed";
    const acquireLease = vi.fn();
    const resume = createResumeHarnessInvocation({
      loadInvocation: async () => f.invocation,
      loadBinding: async () => f.binding,
      loadRuntimeRevision: async () => f.runtimeRevision,
      acquireLease,
      releaseLease: vi.fn(),
      renewLease: vi.fn(async () => true),
      runHosted: vi.fn(),
      resumeExternal: vi.fn(),
    });

    await expect(
      resume({
        tenantId: "tenant-1",
        invocationId: "invocation-1",
        agentCallId: "call-1",
        sourceVersion: 2,
      }),
    ).resolves.toEqual({ status: "handled_noop", invocationId: "invocation-1" });
    expect(acquireLease).not.toHaveBeenCalled();
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
