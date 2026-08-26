import { describe, expect, it, vi } from "vitest";
import { createAgentApiClient } from "./agents";

describe("agent api client（07 §4/§7）", () => {
  it("registerContract 发送 protocol+contract 顶层结构与 Idempotency-Key", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        agent: { id: "agent-1", agent_key: "k", display_name: "n", lifecycle_state: "draft" },
        contract: {},
      }),
    );
    const client = createAgentApiClient({
      baseUrl: "",
      headers: () => ({}),
      fetcher: fetcher as unknown as typeof fetch,
    });

    await client.registerContract(
      { protocol: { type: "a2a", contract_revision: "a2a@1" }, contract: { hello: 1 } },
      { idempotencyKey: "idem-contract" },
    );

    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe("/admin/api/v1/agent-registrations");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("idem-contract");
    expect(JSON.parse(String(init?.body))).toEqual({
      protocol: { type: "a2a", contract_revision: "a2a@1" },
      contract: { hello: 1 },
    });
  });

  it("registerRuntime 发送冻结 wire body 与 Idempotency-Key", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ runtime_id: "rt-1" }),
    );
    const client = createAgentApiClient({
      baseUrl: "",
      headers: () => ({}),
      fetcher: fetcher as unknown as typeof fetch,
    });

    await client.registerRuntime(
      "agent-1",
      {
        contract_snapshot_id: "snap-1",
        runtime_endpoint: "https://agent.example.com",
        authentication: { mode: "bearer", credential_ref_id: "cred-1" },
        conformance: {
          basic: { input: "hi" },
          resume: { start_input: "s", resume_input: "r" },
        },
      },
      { idempotencyKey: "idem-runtime" },
    );

    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe("/admin/api/v1/agents/agent-1/runtime-registrations");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("idem-runtime");
    expect(JSON.parse(String(init?.body))).toEqual({
      contract_snapshot_id: "snap-1",
      runtime_endpoint: "https://agent.example.com",
      authentication: { mode: "bearer", credential_ref_id: "cred-1" },
      conformance: { basic: { input: "hi" }, resume: { start_input: "s", resume_input: "r" } },
    });
  });
});
