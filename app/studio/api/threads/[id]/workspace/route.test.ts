import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 切片 B2 Stage B：Workspaces list/write API 守卫与隔离。
 * mock studio-access(requireStudioAction + hasStudioAction) + queries + workspace，断言：
 * - owner GET 列文件 → 200；POST 写 → 200。
 * - 非 owner（requireThreadForUser → null）→ 404，不泄露（先于 workspace 权限判定）。
 * - 无 workspace.read GET → 403；无 workspace.write POST → 403。
 * - safeJoin / symlink 越界 → 400。
 */

const studioAccess = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const queries = vi.hoisted(() => ({ getThreadById: vi.fn(), requireThreadForUser: vi.fn() }));
const ws = vi.hoisted(() => {
  class FakeWorkspacePathError extends Error {}
  return {
    WorkspacePathError: FakeWorkspacePathError,
    listWorkspaceFiles: vi.fn(),
    writeWorkspaceFile: vi.fn(),
  };
});
const audit = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studioAccess.requireStudioAction,
  hasStudioAction: studioAccess.hasStudioAction,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
}));
vi.mock("@/lib/workspace", () => ({
  WorkspacePathError: ws.WorkspacePathError,
  listWorkspaceFiles: ws.listWorkspaceFiles,
  writeWorkspaceFile: ws.writeWorkspaceFile,
}));
vi.mock("@/lib/studio/admin-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/studio/admin-audit")>();
  return { ...actual, recordAdminAudit: audit.recordAdminAudit };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, POST } from "@/app/studio/api/threads/[id]/workspace/route";
import { NextRequest } from "next/server";

/** requireStudioAction 返回的 Principal：路由读取 userIdentityId 作 owner guard。 */
const PRINCIPAL = {
  tenantId: "t1",
  tenantKey: "t1",
  userIdentityId: "u1",
  externalSubject: "u1",
  email: "a@x",
  displayName: "A",
  audience: "employee",
};

type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function req(url: string, init?: NextInit) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  studioAccess.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  // 默认 member：无 thread.read.all、无 workspace.write，但有 workspace.read
  studioAccess.hasStudioAction.mockImplementation(
    async (_principal: unknown, perm: string) => perm === "workspace.read",
  );
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
  audit.recordAdminAudit.mockResolvedValue(undefined);
});

describe("GET /studio/api/threads/[id]/workspace (切片 B2)", () => {
  it("owner → 200 + { threadId, files }", async () => {
    ws.listWorkspaceFiles.mockResolvedValue(["index.html", "src/app.js"]);
    const res = await GET(req("http://localhost/studio/api/threads/t1/workspace"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.threadId).toBe("t1");
    expect(body.data.files).toEqual(["index.html", "src/app.js"]);
    expect(queries.requireThreadForUser).toHaveBeenCalledWith("t1", "u1");
  });

  it("非 owner → 404，不调 list（先于 workspace.read 判定）", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/workspace"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(ws.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("无 workspace.read → 403", async () => {
    studioAccess.hasStudioAction.mockResolvedValue(false);
    const res = await GET(req("http://localhost/studio/api/threads/t1/workspace"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
    expect(ws.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("admin(thread.read.all) → getThreadById 可访问任意 thread", async () => {
    studioAccess.hasStudioAction.mockImplementation(
      async (_principal: unknown, perm: string) => perm === "thread.read" || perm === "workspace.read",
    );
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    ws.listWorkspaceFiles.mockResolvedValue([]);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/workspace"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("tOther");
  });

  it("无 studio.access → 403（requireStudioAction 守卫）", async () => {
    studioAccess.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/workspace"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });

  it("listWorkspaceFiles 路径安全错误 → 400 invalid_path", async () => {
    ws.listWorkspaceFiles.mockRejectedValue(
      new ws.WorkspacePathError("非法路径（workspace 根为符号链接）"),
    );
    const res = await GET(req("http://localhost/studio/api/threads/t1/workspace"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_path");
  });
});

describe("POST /studio/api/threads/[id]/workspace (切片 B2)", () => {
  function post(body: unknown) {
    return req("http://localhost/studio/api/threads/t1/workspace", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("owner + workspace.write → 200 + { path } + succeeded 审计含 path/bytes", async () => {
    studioAccess.hasStudioAction.mockImplementation(
      async (_uid: string, perm: string) => perm === "workspace.read" || perm === "workspace.write",
    );
    ws.writeWorkspaceFile.mockResolvedValue("src/app.js");
    const res = await POST(post({ path: "src/app.js", content: "console.log(1)" }), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toBe("src/app.js");
    expect(ws.writeWorkspaceFile).toHaveBeenCalledWith("t1", "src/app.js", "console.log(1)");
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.file.written",
        targetType: "workspace",
        targetId: "t1",
        outcome: "succeeded",
        metadata: expect.objectContaining({ path: "src/app.js", bytes: 14 }),
      }),
    );
  });

  it("无 workspace.write → 403，不审计", async () => {
    const res = await POST(post({ path: "src/app.js", content: "x" }), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
    expect(ws.writeWorkspaceFile).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("非 owner → 404（先于 workspace.write 判定，不泄露），不审计", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await POST(post({ path: "x", content: "y" }), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(ws.writeWorkspaceFile).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("path/content 缺失或类型错 → 400 invalid_body，不审计", async () => {
    studioAccess.hasStudioAction.mockImplementation(
      async (_uid: string, perm: string) => perm === "workspace.read" || perm === "workspace.write",
    );
    const res = await POST(post({ path: "", content: "x" }), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_body");
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("越界 path → 400 invalid_path（writeWorkspaceFile throw）+ failed 审计", async () => {
    studioAccess.hasStudioAction.mockImplementation(
      async (_uid: string, perm: string) => perm === "workspace.read" || perm === "workspace.write",
    );
    ws.writeWorkspaceFile.mockRejectedValue(new ws.WorkspacePathError("非法路径（越界工作区）"));
    const res = await POST(post({ path: "../escape.txt", content: "x" }), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_path");
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.file.written",
        outcome: "failed",
        metadata: expect.objectContaining({ reasonCode: "invalid_path", path: "../escape.txt" }),
      }),
    );
  });

  it("普通 workspace 异常不应伪装成 invalid_path", async () => {
    studioAccess.hasStudioAction.mockImplementation(
      async (_uid: string, perm: string) => perm === "workspace.read" || perm === "workspace.write",
    );
    ws.writeWorkspaceFile.mockRejectedValue(new Error("disk full"));
    await expect(
      POST(post({ path: "src/app.js", content: "x" }), {
        params: Promise.resolve({ id: "t1" }),
      }),
    ).rejects.toThrow("disk full");
  });
});
