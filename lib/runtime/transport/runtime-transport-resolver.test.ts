import { defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";
import {
  UnsupportedRuntimeProtocolError,
  createRuntimeTransportResolver,
} from "@/lib/runtime/transport/runtime-transport-resolver";
import { describe, expect, it } from "vitest";

function fakeTransport(name: string): RuntimeTransport {
  return {
    probeCapabilities: async () => defaultRuntimeCapabilities(),
    startInvocation: async (request) => ({
      protocolVersion: 3,
      authority: request.request.authority,
      semanticRequestDigest: request.request.semanticRequestDigest,
      accepted: true,
      remoteSessionRef: `${name}-session`,
      remoteExecutionRef: `${name}-execution`,
      capabilitiesDigest: defaultRuntimeCapabilities().contractDigest,
      acceptedAt: Date.now(),
    }),
    resumeInvocation: async (request) => ({
      protocolVersion: 3,
      authority: request.request.authority,
      semanticRequestDigest: request.request.semanticRequestDigest,
      accepted: true,
      remoteSessionRef: `${name}-session`,
      remoteExecutionRef: `${name}-execution`,
      capabilitiesDigest: defaultRuntimeCapabilities().contractDigest,
      acceptedAt: Date.now(),
    }),
    postEventBatch: async () => ({}),
    heartbeat: async (request) => ({
      protocolVersion: 3,
      authority: request.request.authority,
      serverTime: Date.now(),
      leaseExpiresAt: Date.now() + 30_000,
      acceptedThroughProducerSequence: "0",
      continueExecution: true,
    }),
    cancelInvocation: async (request) => ({
      accepted: true,
      targetAuthority: request.request.targetAuthority,
      stopState: "requested",
    }),
    steerInvocation: async (request) => ({
      accepted: true,
      commandId: request.request.commandId,
      targetAuthority: request.request.targetAuthority,
      inputDigest: request.request.inputDigest,
    }),
    requestSafePoint: async (request) => ({
      accepted: true,
      checkpointIntentId: request.request.checkpointIntentId,
      safePointEvidenceDigest: `sha256:${"0".repeat(64)}`,
      writerQuiescenceAchievedAt: Date.now(),
    }),
    releaseSafePoint: async () => undefined,
  };
}

describe("createRuntimeTransportResolver", () => {
  it("按 RuntimeRevision evidence kind 解析受管和外部 transport", async () => {
    const created: string[] = [];
    const resolve = createRuntimeTransportResolver({
      factories: {
        harness_runtime_protocol: {
          hosted_artifact: () => {
            created.push("hosted");
            return fakeTransport("hosted");
          },
          external_endpoint: () => {
            created.push("external");
            return fakeTransport("external");
          },
        },
      },
    });

    const hosted = await resolve({
      protocolType: "harness_runtime_protocol",
      runtimeEvidenceKind: "hosted_artifact",
      endpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "t" },
    });
    const external = await resolve({
      protocolType: "harness_runtime_protocol",
      runtimeEvidenceKind: "external_endpoint",
      endpoint: "https://runtime.example",
      auth: { mode: "none" },
    });

    expect(created).toEqual(["hosted", "external"]);
    expect(await hosted.probeCapabilities("", { mode: "none" })).toMatchObject({
      protocolVersion: 3,
    });
    expect(await external.probeCapabilities("", { mode: "none" })).toMatchObject({
      protocolVersion: 3,
    });
  });

  it("未知协议或未注册的 evidence kind 失败关闭", async () => {
    const resolve = createRuntimeTransportResolver({
      factories: {
        harness_runtime_protocol: { hosted_artifact: () => fakeTransport("hosted") },
      },
    });

    await expect(
      resolve({
        protocolType: "unknown_protocol",
        runtimeEvidenceKind: "external_endpoint",
        endpoint: "https://x",
        auth: { mode: "none" },
      }),
    ).rejects.toThrow(UnsupportedRuntimeProtocolError);
    await expect(
      resolve({
        protocolType: "harness_runtime_protocol",
        runtimeEvidenceKind: "external_endpoint",
        endpoint: "https://x",
        auth: { mode: "none" },
      }),
    ).rejects.toThrow(UnsupportedRuntimeProtocolError);
  });

  it("工厂只接收受管 endpoint 和身份配置", async () => {
    const seen: Array<{ endpoint: string; auth: { mode: string; token?: string } }> = [];
    const resolve = createRuntimeTransportResolver({
      factories: {
        harness_runtime_protocol: {
          hosted_artifact: (input) => {
            seen.push(input);
            return fakeTransport("hosted");
          },
        },
      },
    });

    await resolve({
      protocolType: "harness_runtime_protocol",
      runtimeEvidenceKind: "hosted_artifact",
      endpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "tok" },
    });
    expect(seen).toEqual([
      { endpoint: "in-process://hosted", auth: { mode: "workload_token", token: "tok" } },
    ]);
  });
});
