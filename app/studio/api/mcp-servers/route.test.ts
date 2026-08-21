import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.4 Stage E：MCP server 管理 API 守卫 + env 脱敏测试。
 * 200（admin / studio.access 读）/ 401（未登录）/ 403（member 写）+ env 脱敏。
 */

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
  resolveStudioPrincipal: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  listMcpServerConfigs: vi.fn(),
  createMcpServerConfig: vi.fn(),
}));
const registry = vi.hoisted(() => ({ removeServer: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));
vi.mock("@/lib/db/queries", () => ({
  listMcpServerConfigs: queries.listMcpServerConfigs,
  createMcpServerConfig: queries.createMcpServerConfig,
  getMcpServerConfig: vi.fn(),
  updateMcpServerConfig: vi.fn(),
  deleteMcpServerConfig: vi.fn(),
}));
vi.mock("@/lib/mcp/registry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/registry")>("@/lib/mcp/registry");
  return { ...actual, removeServer: registry.removeServer };
});

import { DELETE, PUT } from "@/app/studio/api/mcp-servers/[id]/route";
import { GET, POST } from "@/app/studio/api/mcp-servers/route";
import { NextRequest } from "next/server";

const PRINCIPAL = {
  tenantId: "t1",
  tenantKey: "t1",
  userIdentityId: "u1",
  externalSubject: "u1",
  email: "a@x",
  displayName: "A",
  audience: "employee",
} as const;
const unauthResp = (status: number) => ({
  ok: false as const,
  response: new Response("{}", { status }),
});

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
});

describe("GET /studio/api/mcp-servers", () => {
  it("studio.access 通过 → 200 + env 脱敏", async () => {
    queries.listMcpServerConfigs.mockResolvedValue([
      {
        id: "m1",
        name: "github",
        transport: "stdio",
        command: "npx",
        args: null,
        url: null,
        env: { GITHUB_TOKEN: "secret", NORMAL: "v" },
        allowedTools: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = await GET(new NextRequest("http://localhost/studio/api/mcp-servers"));
    expect(res.status).toBe(200);
    expect(studio.requireStudioAction).toHaveBeenCalledWith(expect.anything(), "studio.access");
    const body = await res.json();
    const row = body.data.rows[0];
    expect(row.env).toEqual({ GITHUB_TOKEN: "***", NORMAL: "v" });
    expect(JSON.stringify(body)).not.toMatch(/secret/);
  });

  it("未登录 → 401，不查 list", async () => {
    studio.requireStudioAction.mockResolvedValue(unauthResp(401));
    const res = await GET(new NextRequest("http://localhost/studio/api/mcp-servers"));
    expect(res.status).toBe(401);
    expect(queries.listMcpServerConfigs).not.toHaveBeenCalled();
  });

  it("无 studio 权限 → 403", async () => {
    studio.requireStudioAction.mockResolvedValue(unauthResp(403));
    const res = await GET(new NextRequest("http://localhost/studio/api/mcp-servers"));
    expect(res.status).toBe(403);
  });
});

describe("POST /studio/api/mcp-servers (admin-only)", () => {
  it("policy.write 通过 → 201 风格 200 + 脱敏返回", async () => {
    queries.createMcpServerConfig.mockResolvedValue({
      id: "m1",
      name: "github",
      transport: "stdio",
      command: "npx",
      args: null,
      url: null,
      env: { GITHUB_TOKEN: "secret" },
      allowedTools: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const req = new NextRequest("http://localhost/studio/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "github",
        transport: "stdio",
        command: "npx",
        env: { GITHUB_TOKEN: "secret" },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(studio.requireStudioAction).toHaveBeenCalledWith(expect.anything(), "policy.write");
    expect(queries.createMcpServerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ name: "github" }),
    );
  });

  it("member（无 policy.write）→ 403", async () => {
    studio.requireStudioAction.mockResolvedValue(unauthResp(403));
    const req = new NextRequest("http://localhost/studio/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: "github", transport: "stdio", command: "npx" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(queries.createMcpServerConfig).not.toHaveBeenCalled();
  });

  it("非法 transport → 400", async () => {
    const req = new NextRequest("http://localhost/studio/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: "x", transport: "ftp" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("未登录 → 401", async () => {
    studio.requireStudioAction.mockResolvedValue(unauthResp(401));
    const req = new NextRequest("http://localhost/studio/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: "x", transport: "stdio", command: "x" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /studio/api/mcp-servers/[id] (admin-only)", () => {
  it("policy.write 通过 → 删除 + 回收 client", async () => {
    const { getMcpServerConfig, deleteMcpServerConfig } = await import("@/lib/db/queries");
    (
      getMcpServerConfig as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue({
      id: "m1",
      name: "github",
    });
    (
      deleteMcpServerConfig as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue(undefined);
    registry.removeServer.mockResolvedValue(undefined);
    const req = new NextRequest("http://localhost/studio/api/mcp-servers/m1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    expect(registry.removeServer).toHaveBeenCalledWith("m1", "github");
  });

  it("不存在 → 404", async () => {
    const { getMcpServerConfig } = await import("@/lib/db/queries");
    (
      getMcpServerConfig as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/studio/api/mcp-servers/m1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(404);
  });

  it("member → 403", async () => {
    studio.requireStudioAction.mockResolvedValue(unauthResp(403));
    const req = new NextRequest("http://localhost/studio/api/mcp-servers/m1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(403);
  });
});

describe("PUT /studio/api/mcp-servers/[id] (admin-only)", () => {
  it("policy.write 通过 → 更新 + 脱敏返回", async () => {
    const { updateMcpServerConfig } = await import("@/lib/db/queries");
    (
      updateMcpServerConfig as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue({
      id: "m1",
      name: "github",
      env: { GITHUB_TOKEN: "secret" },
      enabled: false,
    });
    const req = new NextRequest("http://localhost/studio/api/mcp-servers/m1", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.row.env).toEqual({ GITHUB_TOKEN: "***" });
  });
});
