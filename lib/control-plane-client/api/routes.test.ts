import { describe, expect, it, vi } from "vitest";
import { createRouteApiClient } from "./routes";

describe("route api client", () => {
  it("ensureRouteSet 原样发送判别 target body + Idempotency-Key", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: "route-set-1",
        target: { kind: "agent", agent_id: "agent-1" },
        route_scope_key: "default",
        route_scope: {},
        version_no: 7,
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
        created: true,
      }),
    );
    const client = createRouteApiClient({
      baseUrl: "",
      headers: () => ({}),
      fetcher: fetcher as unknown as typeof fetch,
    });

    // 调用方直接传正式判别 body；client 只原样发送，不做 flat adapter。
    const result = await client.ensureRouteSet(
      {
        target: { kind: "agent", agent_id: "agent-1" },
        route_scope_key: "default",
        route_scope: {},
      },
      { idempotencyKey: "idem-ensure-1" },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe("/admin/api/v1/deployment-route-sets");
    expect(init?.method).toBe("POST");
    // 严格 body：{target, route_scope_key, route_scope}，target 为判别 agent 目标。
    expect(JSON.parse(String(init?.body))).toEqual({
      target: { kind: "agent", agent_id: "agent-1" },
      route_scope_key: "default",
      route_scope: {},
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("agent_id");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("idem-ensure-1");
    expect(result).toMatchObject({ id: "route-set-1", version_no: 7 });
  });

  it("activateRouteSet 原样发送 nested target，Agent body 不含 runtime_revision_id", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        route_set_id: "route-set-1",
        route_set_version_no: 8,
        activations: [],
        affected_new_invocations_only: true,
      }),
    );
    const client = createRouteApiClient({
      baseUrl: "",
      headers: () => ({}),
      fetcher: fetcher as unknown as typeof fetch,
    });

    await client.activateRouteSet(
      "route-set-1",
      {
        expected_version_no: 7,
        reason: "发布给员工",
        routes: [
          {
            route_group_id: "primary",
            target: {
              kind: "agent",
              agent_revision_id: "arev-1",
              endpoint_ref: "https://agent.example.com/a2a",
              identity_mode: "bearer",
              credential_ref_id: "cred-1",
              network_zone: "private",
            },
            traffic_weight: 10000,
            priority_no: 0,
          },
        ],
      },
      { idempotencyKey: "idem-activate-1", ifMatch: "route-set-7" },
    );

    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe("/admin/api/v1/deployment-route-sets/route-set-1/activation");
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("if-match")).toBe("route-set-7");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("idem-activate-1");

    // 原样发送：route 携带判别 agent target，绝无 runtime_revision_id / 扁平字段。
    const sent = JSON.parse(String(init?.body)) as {
      routes: Array<Record<string, unknown>>;
    };
    expect(sent.routes[0]!.target).toEqual({
      kind: "agent",
      agent_revision_id: "arev-1",
      endpoint_ref: "https://agent.example.com/a2a",
      identity_mode: "bearer",
      credential_ref_id: "cred-1",
      network_zone: "private",
    });
    expect(String(init?.body)).not.toContain("runtime_revision_id");
    expect(sent.routes[0]).not.toHaveProperty("agent_revision_id");
    expect(sent.routes[0]).not.toHaveProperty("runtime_revision_id");
  });
});
