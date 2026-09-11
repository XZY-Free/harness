import { PUT } from "@/app/api/admin/brand/route";
import { GET } from "@/app/api/brand/route";
import {
  BrandFieldPinnedError,
  BrandValidationError,
  DEFAULT_BRAND,
} from "@/lib/branding/brand-contract";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  get: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  update: vi.fn(),
}));
vi.mock("@/lib/branding/brand-store", () => ({ getBrandStore: () => store }));

const guard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/identity/studio-access", () => ({ requireStudioAction: guard }));

afterEach(() => {
  vi.clearAllMocks();
});

function snapshot(
  name = DEFAULT_BRAND.name,
  revision = 0,
  pinned: Record<string, "file" | "env"> = {},
) {
  return {
    contract: { ...DEFAULT_BRAND, name, revision },
    pinned,
    etag: `"${revision}:0"`,
  };
}

describe("GET /api/brand", () => {
  it("返回品牌合同与 pin 信息并带 ETag", async () => {
    store.get.mockResolvedValue(snapshot("Acme", 3));
    const response = await GET(new NextRequest("https://snow.example.test/api/brand"));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"3:0"');
    const body = (await response.json()) as { brand: { name: string }; pinned: unknown };
    expect(body.brand.name).toBe("Acme");
    expect(body.pinned).toEqual({});
  });

  it("If-None-Match 命中返回 304 且不重复下发状态", async () => {
    store.get.mockResolvedValue(snapshot("Acme", 3));
    const response = await GET(
      new NextRequest("https://snow.example.test/api/brand", {
        headers: { "if-none-match": '"3:0"' },
      }),
    );
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
  });
});

describe("PUT /api/admin/brand", () => {
  it("守卫通过后写入并返回新快照", async () => {
    guard.mockResolvedValue({ ok: true, principal: { userIdentityId: "u-1", tenantId: "t-1" } });
    store.update.mockResolvedValue(snapshot("NewName", 4));
    const response = await PUT(
      new NextRequest("https://snow.example.test/api/admin/brand", {
        method: "PUT",
        body: JSON.stringify({ name: "NewName" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    expect(store.update).toHaveBeenCalledWith({ name: "NewName" }, "u-1");
    const body = (await response.json()) as { data: { etag: string } };
    expect(body.data.etag).toBe('"4:0"');
  });

  it("pin 字段返回 409 BRAND_FIELD_PINNED", async () => {
    guard.mockResolvedValue({ ok: true, principal: { userIdentityId: "u-1", tenantId: "t-1" } });
    store.update.mockRejectedValue(new BrandFieldPinnedError("name", "env"));
    const response = await PUT(
      new NextRequest("https://snow.example.test/api/admin/brand", {
        method: "PUT",
        body: JSON.stringify({ name: "X" }),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BRAND_FIELD_PINNED");
  });

  it("store 校验拒绝时返回 400 BRAND_VALIDATION_FAILED", async () => {
    guard.mockResolvedValue({ ok: true, principal: { userIdentityId: "u-1", tenantId: "t-1" } });
    store.update.mockRejectedValue(new BrandValidationError("icon 仅支持 svg/png/webp/jpeg"));
    const response = await PUT(
      new NextRequest("https://snow.example.test/api/admin/brand", {
        method: "PUT",
        body: JSON.stringify({ icon: "https://evil.example/x.png" }),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BRAND_VALIDATION_FAILED");
  });

  it("非对象请求体直接 400 且不触达 store", async () => {
    guard.mockResolvedValue({ ok: true, principal: { userIdentityId: "u-1", tenantId: "t-1" } });
    const response = await PUT(
      new NextRequest("https://snow.example.test/api/admin/brand", {
        method: "PUT",
        body: JSON.stringify([1, 2]),
      }),
    );
    expect(response.status).toBe(400);
    expect(store.update).not.toHaveBeenCalled();
  });

  it("守卫拒绝时原样返回守卫响应", async () => {
    guard.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const response = await PUT(
      new NextRequest("https://snow.example.test/api/admin/brand", {
        method: "PUT",
        body: JSON.stringify({ name: "X" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(store.update).not.toHaveBeenCalled();
  });
});
