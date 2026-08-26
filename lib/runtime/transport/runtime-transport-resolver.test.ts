import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";
/**
 * RuntimeTransport Resolver 测试 — Batch 6 Gate（04 §3/§10）。
 *
 * 覆盖：protocolType 真正决定 Transport；未知 protocolType fail-closed；
 * Resolver 输入不含 framework/业务分支。
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
  it("agent_runtime_protocol → 对应工厂；a2a → 对应工厂（protocolType 决定 Transport）", async () => {
    const created: string[] = [];
    const resolve = createRuntimeTransportResolver({
      factories: {
        agent_runtime_protocol: () => {
          created.push("hosted");
          return fakeTransport("hosted");
        },
        a2a: () => {
          created.push("a2a");
          return fakeTransport("a2a");
        },
      },
    });
    const hosted = await resolve({
      protocolType: "agent_runtime_protocol",
      endpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "t" },
    });
    const a2a = await resolve({
      protocolType: "a2a",
      endpoint: "https://agent.example.com",
      auth: { mode: "bearer", token: "t" },
    });
    expect(created).toEqual(["hosted", "a2a"]);
    expect(await a2a.startInvocation({} as never)).toEqual({ invocation_id: "a2a" });
    expect(await hosted.probeCapabilities("", { mode: "none" })).toBeDefined();
  });

  it("未知 protocolType → fail-closed（无回退默认 Transport）", async () => {
    const resolve = createRuntimeTransportResolver({
      factories: { a2a: () => fakeTransport("a2a") },
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
        a2a: (input) => {
          seen.push(input);
          return fakeTransport("a2a");
        },
      },
    });
    await resolve({
      protocolType: "a2a",
      endpoint: "https://agent.example.com",
      auth: { mode: "bearer", token: "tok" },
    });
    expect(seen).toEqual([
      { endpoint: "https://agent.example.com", auth: { mode: "bearer", token: "tok" } },
    ]);
  });
});
