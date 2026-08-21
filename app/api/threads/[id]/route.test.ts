import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1（07-P1-4）：thread 写路由 RBAC 权限门测试。
 *
 * 覆盖 PATCH（重命名 / 切 model）+ DELETE（软删除）：
 * - owner 可改自己的 thread
 * - 非 owner 无 thread.write.all → 404（owner guard 不泄露存在性）
 * - admin（thread.write.all）可改他人 thread
 * - 无 thread.write.self 权限 → 403
 * - 未登录 → 401
 *
 * 02-2b：授权契约迁到正式 Action Scope（requireStudioAction / hasStudioAction），mock 相应调整。
 */

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  getThreadByIdForUser: vi.fn(),
  getThreadById: vi.fn(),
  updateThreadTitle: vi.fn(),
  updateThreadModel: vi.fn(),
  softDeleteThread: vi.fn(),
}));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadByIdForUser: queries.getThreadByIdForUser,
  getThreadById: queries.getThreadById,
  updateThreadTitle: queries.updateThreadTitle,
  updateThreadModel: queries.updateThreadModel,
  softDeleteThread: queries.softDeleteThread,
}));

import { DELETE, PATCH } from "@/app/api/threads/[id]/route";

const OWNER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };
const OTHER = { id: "u2", email: "b@x", name: "B", externalId: "u2", createdAt: new Date() };
/** requireStudioAction 返回的 principal：路由读取 userIdentityId 作 owner guard。 */
const PRINCIPAL = { ...OWNER, userIdentityId: "u1", tenantId: "t1" };

function req(url: string, body: unknown, method = "PATCH") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  studio.hasStudioAction.mockResolvedValue(false); // 默认非 admin
  queries.getThreadByIdForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
  queries.updateThreadTitle.mockResolvedValue(undefined);
  queries.updateThreadModel.mockResolvedValue(undefined);
  queries.softDeleteThread.mockResolvedValue(undefined);
});

describe("PATCH /api/threads/[id] (07-P1-4 RBAC)", () => {
  it("owner 可重命名自己的 thread → 200", async () => {
    const res = await PATCH(req("http://localhost/api/threads/t1", { title: "新名" }), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    expect(queries.updateThreadTitle).toHaveBeenCalledWith("t1", "新名");
    // owner 路径走 getThreadByIdForUser（owner guard）
    expect(queries.getThreadByIdForUser).toHaveBeenCalledWith("t1", "u1");
  });

  it("owner 可切 model → 200", async () => {
    const res = await PATCH(req("http://localhost/api/threads/t1", { model: "gpt-4" }), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    expect(queries.updateThreadModel).toHaveBeenCalledWith("t1", "gpt-4");
  });

  it("非 owner 无 thread.write.all → 404（不泄露存在性）", async () => {
    queries.getThreadByIdForUser.mockResolvedValue(null); // foreign → 404
    const res = await PATCH(req("http://localhost/api/threads/tOther", { title: "x" }), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(queries.updateThreadTitle).not.toHaveBeenCalled();
  });

  it("admin（thread.write.all）可改他人 thread → 200", async () => {
    studio.hasStudioAction.mockResolvedValue(true); // admin
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" }); // 他人 thread
    const res = await PATCH(req("http://localhost/api/threads/tOther", { title: "admin 改" }), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.updateThreadTitle).toHaveBeenCalledWith("tOther", "admin 改");
    // admin 路径走 getThreadById（绕过 owner guard）
    expect(queries.getThreadById).toHaveBeenCalledWith("tOther");
  });

  it("无 thread.write.self 权限 → 403", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await PATCH(req("http://localhost/api/threads/t1", { title: "x" }), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
    expect(queries.updateThreadTitle).not.toHaveBeenCalled();
  });

  it("未登录 → 401", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });
    const res = await PATCH(req("http://localhost/api/threads/t1", { title: "x" }), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("admin + thread 不存在 → 404", async () => {
    studio.hasStudioAction.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue(null);
    const res = await PATCH(req("http://localhost/api/threads/ghost", { title: "x" }), {
      params: Promise.resolve({ id: "ghost" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/threads/[id] (07-P1-4 RBAC)", () => {
  it("owner 可软删自己的 thread → 200", async () => {
    const res = await DELETE(req("http://localhost/api/threads/t1", null, "DELETE"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    expect(queries.softDeleteThread).toHaveBeenCalledWith("t1");
  });

  it("非 owner 无 thread.write.all → 404", async () => {
    queries.getThreadByIdForUser.mockResolvedValue(null);
    const res = await DELETE(req("http://localhost/api/threads/tOther", null, "DELETE"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(queries.softDeleteThread).not.toHaveBeenCalled();
  });

  it("admin 可软删他人 thread → 200", async () => {
    studio.hasStudioAction.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    const res = await DELETE(req("http://localhost/api/threads/tOther", null, "DELETE"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.softDeleteThread).toHaveBeenCalledWith("tOther");
  });
});
