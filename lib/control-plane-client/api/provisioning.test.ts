import { describe, expect, it, vi } from "vitest";
import { createProvisioningApiClient } from "./provisioning";

describe("provisioning api client（runtime-only 合同）", () => {
  it("requestProvisioning 发送 POST 且 body 恰为 { route_scope_key }", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: "request-1",
        tenant_id: "tenant-1",
        requester_id: "requester-1",
        route_scope_key: "prod",
        state: "pending",
        current_step: null,
        last_completed_step: null,
        attempt_count: 0,
        next_attempt_at: null,
        last_attempt_at: null,
        lease_expires_at: null,
        last_error: null,
        runtime_id: null,
        runtime_revision_id_checkpoint: null,
        runtime_artifact_id: null,
        runtime_attestation_ids: null,
        conformance_run_id: null,
        runtime_publication_record_id: null,
        route_set_id: null,
        route_set_version_no: null,
        route_id: null,
        route_revision_id: null,
        route_activation_id: null,
        projection_version_no: null,
        workflow_version: "3.0",
        created_at: "2026-08-11T00:00:00.000Z",
        updated_at: "2026-08-11T00:00:00.000Z",
      }),
    );
    const client = createProvisioningApiClient({
      baseUrl: "",
      headers: () => ({}),
      fetcher: fetcher as unknown as typeof fetch,
    });

    const result = await client.requestProvisioning({ route_scope_key: "prod" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe("/admin/api/v1/hosted-provisioning");
    expect(init?.method).toBe("POST");
    // 严格 body：恰好一个 key（runtime-only 请求形状）。
    expect(JSON.parse(String(init?.body))).toEqual({ route_scope_key: "prod" });
    expect(result).toMatchObject({
      id: "request-1",
      route_scope_key: "prod",
      workflow_version: "3.0",
    });
  });

  it("getProvisioningRequest 仍走精确 GET 路径", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: "request-1",
        tenant_id: "tenant-1",
        requester_id: "requester-1",
        route_scope_key: "prod",
        state: "ready",
        current_step: null,
        last_completed_step: "verify_route",
        attempt_count: 3,
        next_attempt_at: null,
        last_attempt_at: null,
        lease_expires_at: null,
        last_error: null,
        runtime_id: "runtime-1",
        runtime_revision_id_checkpoint: "runtime-revision-1",
        runtime_artifact_id: "artifact-runtime-1",
        runtime_attestation_ids: ["attestation-1"],
        conformance_run_id: null,
        runtime_publication_record_id: null,
        route_set_id: null,
        route_set_version_no: null,
        route_id: null,
        route_revision_id: null,
        route_activation_id: null,
        projection_version_no: null,
        workflow_version: "3.0",
        created_at: "2026-08-11T00:00:00.000Z",
        updated_at: "2026-08-11T00:01:00.000Z",
      }),
    );
    const client = createProvisioningApiClient({
      baseUrl: "",
      headers: () => ({}),
      fetcher: fetcher as unknown as typeof fetch,
    });

    const result = await client.getProvisioningRequest("request-1");

    const [input] = fetcher.mock.calls[0] ?? [];
    // getter 路径保持精确（GET 由 fetch 默认，不显式传 method）。
    expect(String(input)).toBe("/admin/api/v1/hosted-provisioning/request-1");
    expect(result.state).toBe("ready");
    expect(result.last_completed_step).toBe("verify_route");
  });
});
