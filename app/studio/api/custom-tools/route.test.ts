import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.4 Stage E：自定义工具管理 API 守卫 + 声明校验测试。
 * 200/401/403 + 非白名单 scriptId / 非法 inputSchema 拒绝。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  listCustomTools: vi.fn(),
  createCustomTool: vi.fn(),
  getCustomTool: vi.fn(),
  deleteCustomTool: vi.fn(),
  updateCustomTool: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({ requirePermission: rbac.requirePermission }));
vi.mock("@/lib/db/queries", () => ({
  listCustomTools: queries.listCustomTools,
  createCustomTool: queries.createCustomTool,
  getCustomTool: queries.getCustomTool,
  deleteCustomTool: queries.deleteCustomTool,
  updateCustomTool: queries.updateCustomTool,
}));

import { DELETE, PUT } from "@/app/studio/api/custom-tools/[id]/route";
import { GET, POST } from "@/app/studio/api/custom-tools/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };
const unauthResp = (status: number) => ({
  ok: false as const,
  response: new Response("{}", { status }),
});

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
});

describe("GET /studio/api/custom-tools", () => {
  it("studio.access 通过 → 200 + rows", async () => {
    queries.listCustomTools.mockResolvedValue([{ id: "c1", name: "deploy", enabled: true }]);
    const res = await GET(new NextRequest("http://localhost/studio/api/custom-tools"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.rows).toHaveLength(1);
  });

  it("未登录 → 401", async () => {
    rbac.requirePermission.mockResolvedValue(unauthResp(401));
    const res = await GET(new NextRequest("http://localhost/studio/api/custom-tools"));
    expect(res.status).toBe(401);
  });
});

describe("POST /studio/api/custom-tools (admin-only + 声明校验)", () => {
  it("合法 webhook 声明 → 200", async () => {
    queries.createCustomTool.mockResolvedValue({ id: "c1", name: "deploy" });
    const req = new NextRequest("http://localhost/studio/api/custom-tools", {
      method: "POST",
      body: JSON.stringify({
        name: "deploy",
        description: "部署",
        inputSchema: { type: "object" },
        executorType: "webhook",
        executorConfig: { url: "https://example.com/h", method: "POST" },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(queries.createCustomTool).toHaveBeenCalled();
  });

  it("非白名单 scriptId → 400", async () => {
    const req = new NextRequest("http://localhost/studio/api/custom-tools", {
      method: "POST",
      body: JSON.stringify({
        name: "evil",
        description: "x",
        inputSchema: { type: "object" },
        executorType: "script",
        executorConfig: { scriptId: "rm-rf" },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(queries.createCustomTool).not.toHaveBeenCalled();
  });

  it("非法 inputSchema → 400", async () => {
    const req = new NextRequest("http://localhost/studio/api/custom-tools", {
      method: "POST",
      body: JSON.stringify({
        name: "bad",
        description: "x",
        inputSchema: { type: "string" },
        executorType: "script",
        executorConfig: { scriptId: "echo" },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("member → 403", async () => {
    rbac.requirePermission.mockResolvedValue(unauthResp(403));
    const req = new NextRequest("http://localhost/studio/api/custom-tools", {
      method: "POST",
      body: JSON.stringify({
        name: "deploy",
        description: "x",
        inputSchema: { type: "object" },
        executorType: "webhook",
        executorConfig: { url: "https://example.com/h", method: "POST" },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /studio/api/custom-tools/[id] (admin-only)", () => {
  it("policy.write 通过 → 删除", async () => {
    queries.getCustomTool.mockResolvedValue({ id: "c1", name: "deploy" });
    queries.deleteCustomTool.mockResolvedValue(undefined);
    const req = new NextRequest("http://localhost/studio/api/custom-tools/c1", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(queries.deleteCustomTool).toHaveBeenCalledWith("c1");
  });

  it("不存在 → 404", async () => {
    queries.getCustomTool.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/studio/api/custom-tools/c1", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(404);
  });

  it("member → 403", async () => {
    rbac.requirePermission.mockResolvedValue(unauthResp(403));
    const req = new NextRequest("http://localhost/studio/api/custom-tools/c1", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(403);
  });
});

describe("PUT /studio/api/custom-tools/[id] (admin-only)", () => {
  it("policy.write 通过 → 更新", async () => {
    queries.updateCustomTool.mockResolvedValue({ id: "c1", name: "deploy", enabled: false });
    const req = new NextRequest("http://localhost/studio/api/custom-tools/c1", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
  });
});
