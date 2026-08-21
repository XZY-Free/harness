import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V5-B1：前台 workspace list API 守卫与隔离。
 *
 * 与 Studio 后台 workspace route.test.ts 对照，但本套聚焦前台门禁差异：
 * - 不要求 studio.access 门禁（直接走 owner + workspace.read）
 * - 内部目录（.snow/.git/node_modules 等）不出现在前台文件列表
 * - foreign → 404（不区分，防枚举），先于 workspace 权限判定
 * - safeJoin / symlink → 400
 */

const studio = vi.hoisted(() => ({
  resolveStudioPrincipal: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const resolver = vi.hoisted(() => ({ authErrorResponse: vi.fn() }));
const queries = vi.hoisted(() => ({ requireThreadForUser: vi.fn() }));
const ws = vi.hoisted(() => {
  class FakeWorkspacePathError extends Error {}
  return {
    WorkspacePathError: FakeWorkspacePathError,
    listWorkspaceFiles: vi.fn(),
    isInternalPath: vi.fn(),
    readWorkspaceFile: vi.fn(),
    workspaceStat: vi.fn(),
  };
});

vi.mock("@/lib/identity/studio-access", () => ({
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
  hasStudioAction: studio.hasStudioAction,
}));
vi.mock("@/lib/identity/resolver", () => ({
  authErrorResponse: resolver.authErrorResponse,
}));
vi.mock("@/lib/db/queries", () => ({ requireThreadForUser: queries.requireThreadForUser }));
vi.mock("@/lib/workspace", () => ({
  WorkspacePathError: ws.WorkspacePathError,
  listWorkspaceFiles: ws.listWorkspaceFiles,
  isInternalPath: ws.isInternalPath,
  readWorkspaceFile: ws.readWorkspaceFile,
  workspaceStat: ws.workspaceStat,
}));

import { GET } from "@/app/api/threads/[id]/workspace/route";
import { NextRequest } from "next/server";

/** requireThreadWorkspaceRead 内部 resolveStudioPrincipal 返回的 principal。 */
const PRINCIPAL = {
  id: "u1",
  email: "a@x",
  name: "A",
  externalId: "u1",
  createdAt: new Date(),
  userIdentityId: "u1",
  tenantId: "t1",
};

type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function req(url: string, init?: NextInit) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.resolveStudioPrincipal.mockResolvedValue(PRINCIPAL);
  resolver.authErrorResponse.mockReturnValue(null);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  studio.hasStudioAction.mockResolvedValue(true);
});

describe("GET /api/threads/[id]/workspace (V5-B1 前台)", () => {
  it("owner + workspace.read → 200 + { threadId, files }，listWorkspaceFiles 传 skipInternal=true", async () => {
    ws.listWorkspaceFiles.mockResolvedValue(["index.html", "README.md", "src/app.js"]);
    const res = await GET(req("http://localhost/api/threads/t1/workspace"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.threadId).toBe("t1");
    expect(body.data.files).toEqual(["index.html", "README.md", "src/app.js"]);
    expect(queries.requireThreadForUser).toHaveBeenCalledWith("t1", "u1");
    expect(ws.listWorkspaceFiles).toHaveBeenCalledWith("t1", { skipInternal: true });
  });

  it("非 owner → 404，不调 list（先于 workspace.read 判定，防枚举）", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/threads/tOther/workspace"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(studio.hasStudioAction).not.toHaveBeenCalled();
    expect(ws.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("无 workspace.read → 403，不调 list", async () => {
    studio.hasStudioAction.mockResolvedValue(false);
    const res = await GET(req("http://localhost/api/threads/t1/workspace"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
    expect(ws.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("认证失败 → 401（authErrorResponse 透传）", async () => {
    studio.resolveStudioPrincipal.mockRejectedValue(new Error("缺少 SSO 用户标识"));
    resolver.authErrorResponse.mockReturnValue(new Response(null, { status: 401 }));
    const res = await GET(req("http://localhost/api/threads/t1/workspace"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });

  it("listWorkspaceFiles 路径安全错误 → 400 invalid_path", async () => {
    ws.listWorkspaceFiles.mockRejectedValue(
      new ws.WorkspacePathError("非法路径（workspace 根为符号链接）"),
    );
    const res = await GET(req("http://localhost/api/threads/t1/workspace"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_path");
  });

  it("普通 workspace 异常不应伪装成 invalid_path", async () => {
    ws.listWorkspaceFiles.mockRejectedValue(new Error("disk full"));
    // P2-1: 非 WorkspacePathError 异常走 jsonError(500, internal_error),不冒泡也不伪装 invalid_path
    const res = await GET(req("http://localhost/api/threads/t1/workspace"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(500);
  });
});
