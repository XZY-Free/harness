import type { RuntimeAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import { PUBLICATION_CONFORMANCE_CASES } from "@/lib/runtime/domain/runtime-conformance";
import { defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import { runPublicationConformanceSuite } from "@/lib/runtime/runtime-conformance-runner";
import { describe, expect, it } from "vitest";

const DIGEST = `sha256:${"b".repeat(64)}`;

function conformingAdapter(): RuntimeAdapter {
  return {
    probeCapabilities: async () => defaultRuntimeCapabilities(),
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
      response: { accepted: true, targetAuthority: params.authority!, stopState: "requested" },
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
        commandId: "00000000-0000-4000-8000-000000000101",
        targetAuthority: params.authority!,
        inputDigest: DIGEST,
      },
    }),
  };
}

describe("runPublicationConformanceSuite", () => {
  it("验证唯一 RuntimeProtocol 所有发布前能力与回执", async () => {
    const results = await runPublicationConformanceSuite({
      tenantId: "00000000-0000-4000-8000-000000000001",
      runtimeRevisionId: "00000000-0000-4000-8000-000000000002",
      runtimeAdapter: conformingAdapter(),
    });

    expect(results.map((result) => result.caseId)).toEqual(PUBLICATION_CONFORMANCE_CASES);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.every((result) => result.evidenceDigest.startsWith("sha256:"))).toBe(true);
  });

  it("能力探测失败时所有发布案例失败关闭", async () => {
    const adapter = conformingAdapter();
    adapter.probeCapabilities = async () => {
      throw new Error("capabilities unavailable");
    };

    const results = await runPublicationConformanceSuite({
      tenantId: "00000000-0000-4000-8000-000000000001",
      runtimeRevisionId: "00000000-0000-4000-8000-000000000002",
      runtimeAdapter: adapter,
    });

    expect(results).toHaveLength(PUBLICATION_CONFORMANCE_CASES.length);
    expect(results.every((result) => !result.passed)).toBe(true);
    expect(
      results.every((result) => result.reason?.includes("capability probe failed") === true),
    ).toBe(true);
  });
});
