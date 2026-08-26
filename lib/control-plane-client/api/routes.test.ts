import { describe, expect, it, vi } from "vitest";
import { createRouteApiClient } from "./routes";

describe("route api client", () => {
  it("ensureRouteSet 以严格 body + Idempotency-Key 调用 create-or-reuse 端点", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: "route-set-1",
        agent_id: "agent-1",
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

    const result = await client.ensureRouteSet(
      { agent_id: "agent-1", route_scope_key: "default", route_scope: {} },
      { idempotencyKey: "idem-ensure-1" },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe("/admin/api/v1/deployment-route-sets");
    expect(init?.method).toBe("POST");
    // 严格 body：恰好三个 key（服务端 exact keys 校验）。
    expect(JSON.parse(String(init?.body))).toEqual({
      agent_id: "agent-1",
      route_scope_key: "default",
      route_scope: {},
    });
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("idem-ensure-1");
    expect(result).toMatchObject({ id: "route-set-1", version_no: 7 });
  });

  it("activateRouteSet 发送 PUT + If-Match + Idempotency-Key", async () => {
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
            agent_revision_id: "arev-1",
            runtime_revision_id: "rtrv-1",
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
  });
});
