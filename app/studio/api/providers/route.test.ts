import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 切片 B1 Stage C：Providers list API 守卫与取数。
 * mock rbac + queries，断言 provider.read 通过 → 200 { rows }；无权限 → 403；
 * 返回不含明文 apiKey（只 apiKeyRef 引用名）。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn() }));
const queries = vi.hoisted(() => ({ listProviders: vi.fn() }));

vi.mock("@/lib/rbac", () => ({ requirePermission: rbac.requirePermission }));
vi.mock("@/lib/db/queries", () => ({ listProviders: queries.listProviders }));

import { GET } from "@/app/studio/api/providers/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
});

describe("GET /studio/api/providers (切片 B1)", () => {
  it("provider.read 通过 → 200 + { rows }", async () => {
    queries.listProviders.mockResolvedValue([
      {
        id: "p1",
        name: "default",
        baseUrl: "https://x/v1",
        apiKeyRef: "LLM_API_KEY",
        isDefault: true,
      },
    ]);
    const res = await GET(new NextRequest("http://localhost/studio/api/providers"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.rows).toHaveLength(1);
    expect(rbac.requirePermission).toHaveBeenCalledWith(expect.anything(), "provider.read");
  });

  it("返回不含明文 apiKey，只 apiKeyRef 引用名", async () => {
    queries.listProviders.mockResolvedValue([
      {
        id: "p1",
        name: "default",
        baseUrl: "https://x/v1",
        apiKeyRef: "LLM_API_KEY",
        isDefault: true,
      },
    ]);
    const res = await GET(new NextRequest("http://localhost/studio/api/providers"));
    const body = await res.json();
    const row = body.data.rows[0];
    expect(row.apiKeyRef).toBe("LLM_API_KEY");
    // 不存在明文 key 字段
    expect(row.apiKey).toBeUndefined();
    expect(row.secret).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });

  it("无 provider.read → 403，不查 list", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(new NextRequest("http://localhost/studio/api/providers"));
    expect(res.status).toBe(403);
    expect(queries.listProviders).not.toHaveBeenCalled();
  });
});
