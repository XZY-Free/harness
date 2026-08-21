import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V10 Phase 7-1：流式上传 API 路由测试。
 *
 * 重点测试：
 * - owner + workspace.read → 200 + { ok, workspacePath, size }
 * - 缺 X-File-Name 头 → 400
 * - 文件名含 ../ → 400
 * - 文件名含 null byte → 400
 * - 文件名含路径分隔符 → 400
 * - 文件名含非法字符 → 400
 * - 未鉴权 → 401
 * - 非 owner → 404
 * - 缺 body → 400
 * - workspace 路径越界 → 400 invalid_path
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
    writeWorkspaceFileFromStream: vi.fn(),
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
  writeWorkspaceFileFromStream: ws.writeWorkspaceFileFromStream,
}));

import { POST } from "@/app/api/threads/[id]/workspace/upload/route";
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

function makeRequest(
  body: ReadableStream<Uint8Array> | null,
  fileName: string | null,
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  };
  if (fileName !== null) {
    headers["x-file-name"] = encodeURIComponent(fileName);
  }
  const init: NextInit = {
    method: "POST",
    headers,
    body: body as unknown as BodyInit,
    duplex: "half",
  };
  return new NextRequest("http://localhost/api/threads/t1/workspace/upload", init);
}

function makeBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.resolveStudioPrincipal.mockResolvedValue(PRINCIPAL);
  resolver.authErrorResponse.mockReturnValue(null);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  studio.hasStudioAction.mockResolvedValue(true);
  ws.writeWorkspaceFileFromStream.mockResolvedValue({ size: 100 });
});

describe("POST /api/threads/[id]/workspace/upload (V10 Phase 7-1)", () => {
  it("owner + workspace.read → 200 + { ok, workspacePath, size }", async () => {
    const body = makeBody([new Uint8Array([1, 2, 3])]);
    const req = makeRequest(body, "report.pdf");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: unknown };
    expect(json.ok).toBe(true);
    expect(json.data).toMatchObject({
      workspacePath: "downloads/report.pdf",
      size: 100,
    });
    // 调用底层流式写入
    expect(ws.writeWorkspaceFileFromStream).toHaveBeenCalledWith(
      "t1",
      "downloads/report.pdf",
      expect.any(Object),
    );
  });

  it("缺 X-File-Name 头 → 400 missing_file_name", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, null);

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("missing_file_name");
    expect(ws.writeWorkspaceFileFromStream).not.toHaveBeenCalled();
  });

  it("X-File-Name URL decode 失败 → 400 invalid_file_name", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = new NextRequest("http://localhost/api/threads/t1/workspace/upload", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "%E0%A4%A", // 残缺的 UTF-8 序列
      },
      body: body as unknown as BodyInit,
      duplex: "half",
    });

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_file_name");
  });

  it("文件名含 ../ → 400 invalid_file_name", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "../../etc/passwd");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_file_name");
    // ../etc/passwd 同时含路径分隔符和 ..，按检测顺序路径分隔符先命中
    expect(json.error.message).toBeTruthy();
  });

  it("文件名含路径分隔符 → 400 invalid_file_name", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "a/b.txt");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_file_name");
    expect(json.error.message).toContain("路径分隔符");
  });

  it("文件名含 null byte → 400 invalid_file_name", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "evil\0.txt");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_file_name");
    expect(json.error.message).toContain("null byte");
  });

  it("文件名以点开头 → 400 invalid_file_name", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, ".hidden");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_file_name");
    expect(json.error.message).toContain("点开头");
  });

  it("文件名含空格 → 400 invalid_file_name", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "with space.txt");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_file_name");
  });

  it("文件名含中文 → 400 invalid_file_name", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "报告.txt");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_file_name");
  });

  it("未鉴权 → 401", async () => {
    studio.resolveStudioPrincipal.mockRejectedValue(new Error("未授权"));
    resolver.authErrorResponse.mockReturnValue(new Response(null, { status: 401 }));
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "report.pdf");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(401);
    expect(ws.writeWorkspaceFileFromStream).not.toHaveBeenCalled();
  });

  it("非 owner → 404 THREAD_NOT_FOUND（防枚举）", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "report.pdf");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(404);
    expect(ws.writeWorkspaceFileFromStream).not.toHaveBeenCalled();
  });

  it("无 workspace.read 权限 → 403 forbidden", async () => {
    studio.hasStudioAction.mockResolvedValue(false);
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "report.pdf");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(403);
    expect(ws.writeWorkspaceFileFromStream).not.toHaveBeenCalled();
  });

  it("workspace 路径越界 → 400 invalid_path", async () => {
    ws.writeWorkspaceFileFromStream.mockRejectedValue(
      new ws.WorkspacePathError("非法路径（越界工作区）"),
    );
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "report.pdf");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_path");
  });

  it("写入失败 → 500 internal_error", async () => {
    ws.writeWorkspaceFileFromStream.mockRejectedValue(new Error("disk full"));
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "report.pdf");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("internal_error");
  });

  it("合法文件名含横线和下划线 → 200", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "report_v2-final.txt");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(200);
  });

  it("合法文件名含多个点 → 200", async () => {
    const body = makeBody([new Uint8Array([1])]);
    const req = makeRequest(body, "archive.tar.gz");

    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });

    expect(res.status).toBe(200);
  });
});
