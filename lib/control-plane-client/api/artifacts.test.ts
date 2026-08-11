import { describe, expect, it, vi } from "vitest";
import { createArtifactApiClient } from "./artifacts";

describe("artifact api client", () => {
  it("发送正式过滤参数与验证幂等头", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ items: [], total: 0 }),
    );
    const client = createArtifactApiClient({
      baseUrl: "",
      headers: () => ({}),
      fetcher: fetcher as unknown as typeof fetch,
    });

    await client.list({ artifact_type: "runtime_revision", revoked: false, limit: 20 });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/admin/api/v1/artifact-attestations?artifact_type=runtime_revision&revoked=false&limit=20",
    );

    await client.verify(
      {
        artifact_type: "runtime_revision",
        artifact_revision_id: "revision-1",
        artifact_digest: `sha256:${"a".repeat(64)}`,
        dsse_envelope_ref: "managed://envelopes/1",
        builder_identity: "builder-1",
      },
      { idempotencyKey: "idem-1" },
    );
    const verifyInit = fetcher.mock.calls[1]?.[1];
    expect(new Headers(verifyInit?.headers).get("idempotency-key")).toBe("idem-1");
  });
});
