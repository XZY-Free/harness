import type { RuntimeAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import { validateRuntimeProtocolCapabilities } from "@/lib/runtime/protocol-conformance";
import { defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import { runPublicationConformanceSuite } from "@/lib/runtime/runtime-conformance-runner";
import { describe, expect, it } from "vitest";

const DIGEST = `sha256:${"c".repeat(64)}`;

function adapterWithCapabilities(capabilities = defaultRuntimeCapabilities()): RuntimeAdapter {
  return {
    probeCapabilities: async () => capabilities,
    startInvocation: async (params) => ({
      response: {
        protocolVersion: 3,
        authority: params.authority!,
        semanticRequestDigest: DIGEST,
        accepted: true,
        remoteSessionRef: "session",
        remoteExecutionRef: "execution",
        capabilitiesDigest: DIGEST,
        acceptedAt: Date.now(),
      },
    }),
    handleCancel: async (params) => ({
      response: { accepted: true, targetAuthority: params.authority!, stopState: "stopped" },
    }),
    handleResume: async (params) => ({
      response: {
        protocolVersion: 3,
        authority: params.authority!,
        semanticRequestDigest: DIGEST,
        accepted: true,
        remoteSessionRef: "session",
        remoteExecutionRef: "execution",
        capabilitiesDigest: DIGEST,
        acceptedAt: Date.now(),
      },
    }),
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
