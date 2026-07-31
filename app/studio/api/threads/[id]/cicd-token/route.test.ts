import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1（09-P2-3）：per-thread CI/CD token 设置 API 测试。
 * 覆盖 GET（hasToken 不返回明文）/ PUT（设置/清除）/ 权限守卫 / 长度校验。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  updateThreadCicdToken: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
  updateThreadCicdToken: queries.updateThreadCicdToken,
}));

import { GET, PUT } from "@/app/studio/api/threads/[id]/cicd-token/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

function req(url: string): NextRequest {
  return new NextRequest(url);
}

function putReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  rbac.hasPermission.mockResolvedValue(false);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1", cicdApiToken: null });
  queries.getThreadById.mockResolvedValue(null);
  queries.updateThreadCicdToken.mockResolvedValue(undefined);
});

describe("GET /studio/api/threads/[id]/cicd-token", () => {
  it("owner + 无 token → 200 + hasToken:false（不返回明文）", async () => {
    const res = await GET(req("http://localhost/studio/api/threads/t1/cicd-token"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ threadId: "t1", hasToken: false });
    // 不返回明文
    expect(JSON.stringify(body)).not.toContain("cicdApiToken");
  });

  it("owner + 有 token → 200 + hasToken:true（不返回明文）", async () => {
    queries.requireThreadForUser.mockResolvedValue({
      id: "t1",
      userId: "u1",
      cicdApiToken: "secret-value",
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/cicd-token"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.hasToken).toBe(true);
    // 不返回明文
    expect(JSON.stringify(body)).not.toContain("secret-value");
  });

  it("foreign thread → 404", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/t1/cicd-token"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /studio/api/threads/[id]/cicd-token", () => {
  beforeEach(() => {
    // P2-8: PUT 需 admin;happy path 默认 admin
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "t1", userId: "u1", cicdApiToken: null });
  });

  it("admin 设置 token → 200 + hasToken:true + 调 updateThreadCicdToken", async () => {
    const res = await PUT(
      putReq("http://localhost/studio/api/threads/t1/cicd-token", { cicdApiToken: "new-token" }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.hasToken).toBe(true);
    expect(queries.updateThreadCicdToken).toHaveBeenCalledWith("t1", "new-token");
  });

  it("admin 清除 token（null）→ 200 + hasToken:false", async () => {
    const res = await PUT(
      putReq("http://localhost/studio/api/threads/t1/cicd-token", { cicdApiToken: null }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.hasToken).toBe(false);
    expect(queries.updateThreadCicdToken).toHaveBeenCalledWith("t1", null);
  });

  it("缺 cicdApiToken 字段 → 400", async () => {
    const res = await PUT(putReq("http://localhost/studio/api/threads/t1/cicd-token", {}), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(400);
    expect(queries.updateThreadCicdToken).not.toHaveBeenCalled();
  });

  it("超长 token（>2048）→ 400", async () => {
    const res = await PUT(
      putReq("http://localhost/studio/api/threads/t1/cicd-token", {
        cicdApiToken: "x".repeat(2049),
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(400);
    expect(queries.updateThreadCicdToken).not.toHaveBeenCalled();
  });

  it("token 含 CRLF → 400(防 header 注入)", async () => {
    const res = await PUT(
      putReq("http://localhost/studio/api/threads/t1/cicd-token", {
        cicdApiToken: "evil\r\nX: y",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(400);
    expect(queries.updateThreadCicdToken).not.toHaveBeenCalled();
  });

  it("P2-8: member owner 不可设置 → 403", async () => {
    rbac.hasPermission.mockResolvedValue(false);
    const res = await PUT(
      putReq("http://localhost/studio/api/threads/t1/cicd-token", { cicdApiToken: "x" }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(403);
    expect(queries.updateThreadCicdToken).not.toHaveBeenCalled();
  });

  it("foreign thread → 404，不更新", async () => {
    queries.getThreadById.mockResolvedValue(null);
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await PUT(
      putReq("http://localhost/studio/api/threads/t1/cicd-token", { cicdApiToken: "x" }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(404);
    expect(queries.updateThreadCicdToken).not.toHaveBeenCalled();
  });
});
