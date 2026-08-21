import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1（07-P1-4）：thread 创建路由 RBAC 权限门测试。
 *
 * 覆盖 POST（新建会话）：
 * - 有 thread.write.self → 200，创建成功
 * - 无 thread.write.self → 403
 * - 未登录 → 401
 * GET（列表）不在本测试范围（未启用 RBAC，走原 owner scope）。
 * 02-2b：授权契约迁到正式 Action Scope（requireStudioAction），mock 相应调整。
 */

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  resolveStudioPrincipal: vi.fn(),
}));
const queries = vi.hoisted(() => ({ saveThread: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));
vi.mock("@/lib/db/queries", () => ({
  saveThread: queries.saveThread,
  listThreadsForUser: vi.fn(),
}));

import { POST } from "@/app/api/threads/route";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };
/** requireStudioAction 返回的 principal：路由读取 userIdentityId/tenantId。 */
const PRINCIPAL = { ...USER, userIdentityId: "u1", tenantId: "t1" };

function req(body: unknown) {
  return new Request("http://localhost/api/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  studio.resolveStudioPrincipal.mockResolvedValue(PRINCIPAL);
  queries.saveThread.mockResolvedValue(undefined);
});

describe("POST /api/threads (07-P1-4 RBAC)", () => {
  it("有 thread.write.self → 200，落库创建", async () => {
    const res = await POST(req({ title: "新会话", model: "gpt-4" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe("新会话");
    expect(queries.saveThread).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", title: "新会话", model: "gpt-4" }),
    );
  });

  it("无 thread.write.self → 403", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await POST(req({ title: "x" }));
    expect(res.status).toBe(403);
    expect(queries.saveThread).not.toHaveBeenCalled();
  });

  it("未登录 → 401", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });
    const res = await POST(req({ title: "x" }));
    expect(res.status).toBe(401);
  });

  it("title 缺省 → '新会话'", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("新会话");
  });
});
