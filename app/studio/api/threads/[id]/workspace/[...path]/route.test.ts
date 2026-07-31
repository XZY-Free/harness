import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 切片 B2 Stage B：Workspaces read/delete API（catch-all path）守卫与隔离。
 * 断言：读 200 / 删 200 / 非 owner 404 / 无权限 403 / 越界 400 / 不存在 404。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({ getThreadById: vi.fn(), requireThreadForUser: vi.fn() }));
const ws = vi.hoisted(() => ({
  WorkspacePathError: class FakeWorkspacePathError extends Error {},
  readWorkspaceFile: vi.fn(),
  deleteWorkspaceFile: vi.fn(),
  workspaceStat: vi.fn(),
}));
const audit = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
}));
vi.mock("@/lib/workspace", () => ({
  WorkspacePathError: ws.WorkspacePathError,
  readWorkspaceFile: ws.readWorkspaceFile,
  deleteWorkspaceFile: ws.deleteWorkspaceFile,
  workspaceStat: ws.workspaceStat,
}));
vi.mock("@/lib/studio/admin-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/studio/admin-audit")>();
  return { ...actual, recordAdminAudit: audit.recordAdminAudit };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DELETE, GET } from "@/app/studio/api/threads/[id]/workspace/[...path]/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function req(url: string, init?: NextInit) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  rbac.hasPermission.mockImplementation(
    async (_uid: string, perm: string) => perm === "workspace.read",
  );
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
  audit.recordAdminAudit.mockResolvedValue(undefined);
});

describe("GET /studio/api/threads/[id]/workspace/[...path] (切片 B2)", () => {
  it("owner 读文件 → 200 + { path, content, stat }", async () => {
    ws.readWorkspaceFile.mockResolvedValue("hello");
    ws.workspaceStat.mockResolvedValue({ size: 5, mtime: new Date(0), isDirectory: false });
    const res = await GET(req("http://localhost/studio/api/threads/t1/workspace/notes.txt"), {
      params: Promise.resolve({ id: "t1", path: ["notes.txt"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toBe("notes.txt");
    expect(body.data.content).toBe("hello");
    expect(ws.readWorkspaceFile).toHaveBeenCalledWith("t1", "notes.txt");
  });

  it("嵌套路径 path 数组 join 为相对路径", async () => {
    ws.readWorkspaceFile.mockResolvedValue("x");
    ws.workspaceStat.mockResolvedValue({ size: 1, mtime: new Date(0), isDirectory: false });
    await GET(req("http://localhost/studio/api/threads/t1/workspace/src/app.js"), {
      params: Promise.resolve({ id: "t1", path: ["src", "app.js"] }),
    });
    expect(ws.readWorkspaceFile).toHaveBeenCalledWith("t1", "src/app.js");
  });

  it("文件不存在 → 404", async () => {
    ws.readWorkspaceFile.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/t1/workspace/missing.txt"), {
      params: Promise.resolve({ id: "t1", path: ["missing.txt"] }),
    });
    expect(res.status).toBe(404);
  });

  it("非 owner → 404（先于 workspace.read 判定）", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/workspace/x.txt"), {
      params: Promise.resolve({ id: "tOther", path: ["x.txt"] }),
    });
    expect(res.status).toBe(404);
    expect(ws.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("无 workspace.read → 403", async () => {
    rbac.hasPermission.mockResolvedValue(false);
    const res = await GET(req("http://localhost/studio/api/threads/t1/workspace/x.txt"), {
      params: Promise.resolve({ id: "t1", path: ["x.txt"] }),
    });
    expect(res.status).toBe(403);
  });

  it("越界 path → 400 invalid_path", async () => {
    ws.readWorkspaceFile.mockRejectedValue(new ws.WorkspacePathError("非法路径（越界工作区）"));
    const res = await GET(req("http://localhost/studio/api/threads/t1/workspace/x.txt"), {
      params: Promise.resolve({ id: "t1", path: ["..", "escape.txt"] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_path");
  });

  it("普通 read 异常不应伪装成 invalid_path", async () => {
    ws.readWorkspaceFile.mockRejectedValue(new Error("read failed"));
    await expect(
      GET(req("http://localhost/studio/api/threads/t1/workspace/x.txt"), {
        params: Promise.resolve({ id: "t1", path: ["x.txt"] }),
      }),
    ).rejects.toThrow("read failed");
  });
});

describe("DELETE /studio/api/threads/[id]/workspace/[...path] (切片 B2 + C)", () => {
  it("owner + workspace.write → 200 + { deleted: true } + succeeded 审计", async () => {
    rbac.hasPermission.mockImplementation(
      async (_uid: string, perm: string) => perm === "workspace.read" || perm === "workspace.write",
    );
    ws.deleteWorkspaceFile.mockResolvedValue(true);
    const res = await DELETE(
      req("http://localhost/studio/api/threads/t1/workspace/tmp.txt", { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "t1", path: ["tmp.txt"] }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
    expect(ws.deleteWorkspaceFile).toHaveBeenCalledWith("t1", "tmp.txt");
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.file.deleted",
        targetType: "workspace",
        targetId: "t1",
        outcome: "succeeded",
        metadata: { path: "tmp.txt", deleted: true },
      }),
    );
  });

  it("删不存在文件 → 200 + { deleted: false } + succeeded 审计 deleted:false", async () => {
    rbac.hasPermission.mockImplementation(
      async (_uid: string, perm: string) => perm === "workspace.read" || perm === "workspace.write",
    );
    ws.deleteWorkspaceFile.mockResolvedValue(false);
    const res = await DELETE(
      req("http://localhost/studio/api/threads/t1/workspace/nope.txt", { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "t1", path: ["nope.txt"] }),
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.deleted).toBe(false);
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "succeeded",
        metadata: { path: "nope.txt", deleted: false },
      }),
    );
  });

  it("删目录 → 400 invalid_path + failed 审计", async () => {
    rbac.hasPermission.mockImplementation(
      async (_uid: string, perm: string) => perm === "workspace.read" || perm === "workspace.write",
    );
    ws.deleteWorkspaceFile.mockRejectedValue(new ws.WorkspacePathError("非法操作：拒绝删除目录"));
    const res = await DELETE(
      req("http://localhost/studio/api/threads/t1/workspace/dir", { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "t1", path: ["dir"] }),
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_path");
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.file.deleted",
        outcome: "failed",
        metadata: expect.objectContaining({ reasonCode: "invalid_path", path: "dir" }),
      }),
    );
  });

  it("普通 delete 异常不应伪装成 invalid_path，也不审计", async () => {
    rbac.hasPermission.mockImplementation(
      async (_uid: string, perm: string) => perm === "workspace.read" || perm === "workspace.write",
    );
    ws.deleteWorkspaceFile.mockRejectedValue(new Error("unlink failed"));
    await expect(
      DELETE(
        req("http://localhost/studio/api/threads/t1/workspace/tmp.txt", { method: "DELETE" }),
        {
          params: Promise.resolve({ id: "t1", path: ["tmp.txt"] }),
        },
      ),
    ).rejects.toThrow("unlink failed");
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("无 workspace.write → 403，不审计", async () => {
    const res = await DELETE(
      req("http://localhost/studio/api/threads/t1/workspace/tmp.txt", { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "t1", path: ["tmp.txt"] }),
      },
    );
    expect(res.status).toBe(403);
    expect(ws.deleteWorkspaceFile).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("非 owner → 404（先于权限判定），不审计", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await DELETE(
      req("http://localhost/studio/api/threads/tOther/workspace/x.txt", { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "tOther", path: ["x.txt"] }),
      },
    );
    expect(res.status).toBe(404);
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });
});
