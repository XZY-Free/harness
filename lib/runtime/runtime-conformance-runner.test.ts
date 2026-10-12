import type { RuntimeAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { PUBLICATION_CONFORMANCE_CASES } from "@/lib/runtime/domain/runtime-conformance";
import { defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import { runPublicationConformanceSuite } from "@/lib/runtime/runtime-conformance-runner";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { describe, expect, it } from "vitest";

const CAPABILITIES = defaultRuntimeCapabilities();
const DIGEST = `sha256:${"b".repeat(64)}`;

/**
 * 合格候选 Runtime 的接纳回执摘要：由**发布事实**（runtimeRevisionId + 冻结
 * capability manifest）计算，与 runtime-start / in-process Hosted 同源。
 * 自报 probe 的 `contractDigest` 不是发布事实，不能作为回执摘要。
 */
function publishedCapabilitiesDigest(runtimeRevisionId: string): string {
  return expectedCapabilityManifestDigest({
    runtimeRevisionId,
    runtimeCapabilitiesJson: CAPABILITIES,
  });
}

function conformingAdapter(): RuntimeAdapter {
  return {
    probeCapabilities: async () => CAPABILITIES,
    startInvocation: async (params) => {
      // 真实声明与真实接受必须一致：未声明的 Workspace profile 必须 fail closed。
      if (
        params.workspace?.mode === "BOUND" &&
        !CAPABILITIES.features.workspaceModes.includes(params.workspace.continuityMode)
      ) {
        throw new Error(`RUNTIME_WORKSPACE_MODE_UNSUPPORTED: ${params.workspace.continuityMode}`);
      }
      return {
        response: {
          protocolVersion: 3,
          authority: params.authority!,
          // 语义摘要必须只由语义域字段决定：同一意图重试稳定，内容变更必须不同。
          semanticRequestDigest: protocolDigest({
            intentType: "start",
            invocationId: params.invocationId,
            inputItems: params.inputItems,
          }),
          accepted: true,
          remoteSessionRef: `session:${params.authority!.sessionBindingId}`,
          remoteExecutionRef: `execution:${params.invocationId}:${params.authority!.ownershipId}`,
          capabilitiesDigest: publishedCapabilitiesDigest(params.authority!.runtimeRevisionId),
          acceptedAt: Date.now(),
        },
      };
    },
    handleCancel: async (params) => ({
      response: { accepted: true, targetAuthority: params.authority!, stopState: "requested" },
    }),
    handleResume: async (params) => ({
      response: {
        protocolVersion: 3,
        authority: params.authority!,
        semanticRequestDigest: DIGEST,
        accepted: true,
        remoteSessionRef: `session:${params.authority!.sessionBindingId}`,
        remoteExecutionRef: `execution:${params.invocationId}:${params.authority!.ownershipId}`,
        capabilitiesDigest: publishedCapabilitiesDigest(params.authority!.runtimeRevisionId),
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
