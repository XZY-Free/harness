import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";
/**
 * RuntimeTransport Resolver 测试 — Batch 6 Gate（04 §3/§10）。
 *
 * 覆盖：protocolType 真正决定 Transport；未知 protocolType fail-closed；
 * Resolver 输入不含 framework/业务分支。
 *
 * 专题01 冻结架构：Runtime 仅 harness_runtime_protocol；a2a 不再作为
 * Runtime 协议注册（A2A 属后续 AgentCall 批次）。
 */
import {
  UnsupportedRuntimeProtocolError,
  createRuntimeTransportResolver,
} from "@/lib/runtime/transport/runtime-transport-resolver";
import { describe, expect, it } from "vitest";

function fakeTransport(name: string): RuntimeTransport {
  return {
    probeCapabilities: async () =>
      ({ protocol_versions: ["2"], features: {} as never, limits: {} as never }) as never,
    startInvocation: async () => ({ invocation_id: name }) as never,
    cancelInvocation: async () => ({ invocation_id: name }) as never,
    resumeInvocation: async () => ({ invocation_id: name }) as never,
    steerInvocation: async () => ({ invocation_id: name }) as never,
  };
}

describe("createRuntimeTransportResolver（04 §3）", () => {
  it("同一 harness_runtime_protocol 按 runtimeEvidenceKind 分流 Hosted 与 External", async () => {
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
    expect(await hosted.probeCapabilities("", { mode: "none" })).toBeDefined();
    expect((await external.startInvocation({} as never)).invocation_id).toBe("external");
  });

  it("未知 protocolType → fail-closed（无回退默认 Transport）", async () => {
    const resolve = createRuntimeTransportResolver({
      factories: {
        harness_runtime_protocol: { hosted_artifact: () => fakeTransport("hosted") },
      },
    });
    await expect(
      resolve({
        protocolType: "agentkit",
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

  it("工厂接收 managed endpoint/identity configuration（无 framework name/project path 输入）", async () => {
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
