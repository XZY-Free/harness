import { describe, expect, it, vi } from "vitest";
import { createRuntimeApiClient } from "./runtimes";

describe("runtime api client", () => {
  it("发布、撤回和 Conformance 录入发送正式并发控制头", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "ok" }),
    );
    const client = createRuntimeApiClient({
      baseUrl: "",
      headers: () => ({}),
      fetcher: fetcher as unknown as typeof fetch,
    });

    await client.publishRevision(
      "revision-1",
      { expected_version_no: 3, attestation_id: "attestation-1", conformance_run_id: "run-1" },
      { idempotencyKey: "idem-publish", ifMatch: "runtime-revision-1" },
    );
    await client.withdrawRevision(
      "revision-1",
      { reason_code: "security_response", reason: "发现风险" },
      { idempotencyKey: "idem-withdraw", ifMatch: "runtime-revision-1" },
    );
    await client.recordConformanceRun(
      "revision-1",
      { dsse_envelope: "{}" },
      { idempotencyKey: "idem-conformance" },
    );

    for (const [index, idempotencyKey] of [
      "idem-publish",
      "idem-withdraw",
      "idem-conformance",
    ].entries()) {
      const init = fetcher.mock.calls[index]?.[1];
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(idempotencyKey);
    }
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("if-match")).toBe(
      "runtime-revision-1",
    );
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("if-match")).toBe(
      "runtime-revision-1",
    );
  });
});
