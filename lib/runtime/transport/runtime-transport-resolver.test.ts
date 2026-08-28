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
  it("harness_runtime_protocol → 对应工厂（protocolType 决定 Transport）", async () => {
    const created: string[] = [];
    const resolve = createRuntimeTransportResolver({
      factories: {
        harness_runtime_protocol: () => {
          created.push("hosted");
          return fakeTransport("hosted");
        },
      },
    });
    const hosted = await resolve({
      protocolType: "harness_runtime_protocol",
      endpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "t" },
    });
    expect(created).toEqual(["hosted"]);
    expect(await hosted.probeCapabilities("", { mode: "none" })).toBeDefined();
  });

  it("未知 protocolType → fail-closed（无回退默认 Transport）", async () => {
    const resolve = createRuntimeTransportResolver({
      factories: { harness_runtime_protocol: () => fakeTransport("hosted") },
    });
    await expect(
      resolve({ protocolType: "agentkit", endpoint: "https://x", auth: { mode: "none" } }),
    ).rejects.toThrow(UnsupportedRuntimeProtocolError);
    await expect(
      resolve({ protocolType: "langgraph", endpoint: "https://x", auth: { mode: "none" } }),
    ).rejects.toThrow(UnsupportedRuntimeProtocolError);
  });

  it("工厂接收 managed endpoint/identity configuration（无 framework name/project path 输入）", async () => {
    const seen: Array<{ endpoint: string; auth: { mode: string; token?: string } }> = [];
    const resolve = createRuntimeTransportResolver({
      factories: {
        harness_runtime_protocol: (input) => {
          seen.push(input);
          return fakeTransport("hosted");
        },
      },
    });
    await resolve({
      protocolType: "harness_runtime_protocol",
      endpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "tok" },
    });
    expect(seen).toEqual([
      { endpoint: "in-process://hosted", auth: { mode: "workload_token", token: "tok" } },
    ]);
  });
});
