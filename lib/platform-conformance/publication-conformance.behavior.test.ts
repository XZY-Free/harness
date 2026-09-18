import type { RuntimeAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { validateRuntimeProtocolCapabilities } from "@/lib/runtime/protocol-conformance";
import { defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import { runPublicationConformanceSuite } from "@/lib/runtime/runtime-conformance-runner";
import { type AuthorityIdentity, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { describe, expect, it } from "vitest";

const DIGEST = `sha256:${"c".repeat(64)}`;

function adapterWithCapabilities(
  capabilities: ReturnType<typeof defaultRuntimeCapabilities> = defaultRuntimeCapabilities(),
): RuntimeAdapter {
  const startResponse = (params: {
    invocationId: string;
    authority?: AuthorityIdentity;
    inputItems?: unknown[];
  }) => ({
    protocolVersion: 3 as const,
    authority: params.authority!,
    // 语义摘要只由语义域字段决定：重试稳定、内容变更不同。
    semanticRequestDigest: protocolDigest({
      intentType: "start",
      invocationId: params.invocationId,
      inputItems: params.inputItems ?? null,
    }),
    accepted: true as const,
    remoteSessionRef: `session:${params.authority!.sessionBindingId}`,
    remoteExecutionRef: `execution:${params.invocationId}:${params.authority!.ownershipId}`,
    // 回执摘要必须由**发布事实**（runtimeRevisionId + 冻结 manifest）计算，
    // 与 runtime-start / in-process Hosted 同源。
    capabilitiesDigest: expectedCapabilityManifestDigest({
      runtimeRevisionId: params.authority!.runtimeRevisionId,
      runtimeCapabilitiesJson: capabilities,
    }),
    acceptedAt: Date.now(),
  });
  return {
    probeCapabilities: async () => capabilities,
    startInvocation: async (params) => {
      // 真实声明与真实接受必须一致：未声明的 Workspace profile 必须 fail closed。
      if (
        params.workspace?.mode === "BOUND" &&
        !capabilities.features.workspaceModes.includes(params.workspace.continuityMode)
      ) {
        throw new Error(`RUNTIME_WORKSPACE_MODE_UNSUPPORTED: ${params.workspace.continuityMode}`);
      }
      return { response: startResponse(params) };
    },
    handleCancel: async (params) => ({
      response: { accepted: true, targetAuthority: params.authority!, stopState: "stopped" },
    }),
    handleResume: async (params) => ({ response: startResponse(params) }),
    handleSteer: async (params) => ({
      response: {
        accepted: true,
        commandId: "00000000-0000-4000-8000-000000000201",
        targetAuthority: params.authority!,
        inputDigest: DIGEST,
      },
    }),
  };
}

describe("Runtime publication conformance", () => {
  it("要求固定 fencing 能力、完整 subject profile 与受支持的 workspace profile", () => {
    expect(() => validateRuntimeProtocolCapabilities(defaultRuntimeCapabilities())).not.toThrow();

    const malformed = defaultRuntimeCapabilities();
    malformed.features.subjectTypes = ["thread"];
    expect(() => validateRuntimeProtocolCapabilities(malformed)).toThrow("thread/job");
  });

  it("Runtime 回执必须绑定 runner 传入的同一 Authority", async () => {
    const adapter = adapterWithCapabilities();
    adapter.handleCancel = async (params) => ({
      response: {
        accepted: true,
        targetAuthority: { ...params.authority!, leaseEpoch: "2" },
        stopState: "requested",
      },
    });

    const results = await runPublicationConformanceSuite({
      tenantId: "00000000-0000-4000-8000-000000000001",
      runtimeRevisionId: "00000000-0000-4000-8000-000000000002",
      runtimeAdapter: adapter,
    });

    expect(results.find((result) => result.caseId === "cancel-acknowledgement")?.passed).toBe(
      false,
    );
  });
});
