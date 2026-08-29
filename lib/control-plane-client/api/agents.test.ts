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
});
