import { describe, expect, it, vi } from "vitest";
import { ControlPlaneRequestError, createControlPlaneRequest } from "./http-client";

describe("control plane HTTP client", () => {
  it("合并认证头并直接返回服务端资源", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ items: [{ id: "agent-1" }], total: 1 }),
    );
    const request = createControlPlaneRequest({
      baseUrl: "https://control.example.test/",
      headers: () => ({ Authorization: "Bearer test" }),
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(request("/admin/api/v1/agents")).resolves.toEqual({
      items: [{ id: "agent-1" }],
      total: 1,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://control.example.test/admin/api/v1/agents",
      expect.any(Object),
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test");
  });

  it("解析正式 error envelope 并保留 request_id、retryable 与 details", async () => {
    const request = createControlPlaneRequest({
      baseUrl: "",
      headers: () => ({}),
      fetcher: vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "ETAG_MISMATCH",
              message: "版本冲突",
              request_id: "req-1",
              retryable: false,
              details: { expected: 3 },
            },
          },
          { status: 412 },
        ),
      ) as unknown as typeof fetch,
    });

    const error = await request("/admin/api/v1/resource").catch((value) => value);
    expect(error).toBeInstanceOf(ControlPlaneRequestError);
    expect(error).toMatchObject({
      code: "ETAG_MISMATCH",
      message: "版本冲突",
      requestId: "req-1",
      retryable: false,
      status: 412,
      details: { expected: 3 },
    });
  });

  it("非正式错误响应 fail-closed 为 INTERNAL_ERROR", async () => {
    const request = createControlPlaneRequest({
      baseUrl: "",
      headers: () => ({}),
      fetcher: vi.fn(
        async () => new Response("upstream failed", { status: 502 }),
      ) as unknown as typeof fetch,
    });

    await expect(request("/admin/api/v1/resource")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 502,
      retryable: true,
    });
  });
});
