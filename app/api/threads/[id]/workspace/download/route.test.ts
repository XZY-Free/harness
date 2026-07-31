import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V10 Phase 7-2：Workspace 一次性下载凭证 API 路由测试。
 *
 * 重点测试：
 * - 缺少 token → 400 missing_token
 * - 无效 token → 403 invalid_token
 * - 有效 token 但 threadId 不匹配 → 403 invalid_token
 * - 有效 token + 正确 threadId → 200 + 文件内容
 * - 同一 token 第二次使用 → 403 invalid_token（一次性）
 * - 文件不存在 → 404 file_not_found
 * - 内部目录路径 → 404 file_not_found（防枚举）
 *
 * 通过 mock consumeUploadToken / readWorkspaceFileBytes / isInternalPath 隔离底层。
 */

const tokenModule = vi.hoisted(() => ({
  consumeUploadToken: vi.fn(),
}));

const ws = vi.hoisted(() => ({
  isInternalPath: vi.fn(),
  readWorkspaceFileBytes: vi.fn(),
}));

vi.mock("@/lib/workspace-upload-token", () => ({
  consumeUploadToken: tokenModule.consumeUploadToken,
}));

vi.mock("@/lib/workspace", () => ({
  isInternalPath: ws.isInternalPath,
  readWorkspaceFileBytes: ws.readWorkspaceFileBytes,
}));

import { GET } from "@/app/api/threads/[id]/workspace/download/route";
import { NextRequest } from "next/server";

function makeRequest(threadId: string, token: string | null): NextRequest {
  const url =
    token !== null
      ? `http://localhost/api/threads/${threadId}/workspace/download?token=${token}`
      : `http://localhost/api/threads/${threadId}/workspace/download`;
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认非内部路径
  ws.isInternalPath.mockReturnValue(false);
});

describe("GET /api/threads/[id]/workspace/download (V10 Phase 7-2)", () => {
  it("缺少 token → 400 missing_token", async () => {
    const req = makeRequest("t1", null);
    const res = await GET(req, { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("missing_token");
    expect(tokenModule.consumeUploadToken).not.toHaveBeenCalled();
  });

  it("无效 token → 403 invalid_token", async () => {
    tokenModule.consumeUploadToken.mockReturnValue(null);
    const req = makeRequest("t1", "invalid-token");
    const res = await GET(req, { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_token");
    expect(ws.readWorkspaceFileBytes).not.toHaveBeenCalled();
  });

  it("有效 token 但 threadId 不匹配 → 403 invalid_token", async () => {
    tokenModule.consumeUploadToken.mockReturnValue({
      threadId: "other-thread",
      workspacePath: "uploads/x.png",
    });
    const req = makeRequest("t1", "valid-token");
    const res = await GET(req, { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_token");
    expect(ws.readWorkspaceFileBytes).not.toHaveBeenCalled();
  });

  it("有效 token + 正确 threadId → 200 + 文件内容", async () => {
    const fileBytes = new Uint8Array([1, 2, 3, 4]);
    tokenModule.consumeUploadToken.mockReturnValue({
      threadId: "t1",
      workspacePath: "uploads/image.png",
    });
    ws.readWorkspaceFileBytes.mockResolvedValue(fileBytes);
    const req = makeRequest("t1", "valid-token");
    const res = await GET(req, { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(ws.readWorkspaceFileBytes).toHaveBeenCalledWith("t1", "uploads/image.png");
    const body = await res.arrayBuffer();
    expect(new Uint8Array(body)).toEqual(fileBytes);
  });

  it("同一 token 第二次使用 → 403（一次性）", async () => {
    // 模拟一次性消费：第一次返回有效，第二次返回 null
    tokenModule.consumeUploadToken
      .mockReturnValueOnce({ threadId: "t1", workspacePath: "uploads/x.png" })
      .mockReturnValueOnce(null);
    ws.readWorkspaceFileBytes.mockResolvedValue(new Uint8Array([1]));
    const req1 = makeRequest("t1", "same-token");
    const req2 = makeRequest("t1", "same-token");
    const res1 = await GET(req1, { params: Promise.resolve({ id: "t1" }) });
    const res2 = await GET(req2, { params: Promise.resolve({ id: "t1" }) });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(403);
    const json = (await res2.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_token");
  });

  it("文件不存在 → 404 file_not_found", async () => {
    tokenModule.consumeUploadToken.mockReturnValue({
      threadId: "t1",
      workspacePath: "uploads/missing.png",
    });
    ws.readWorkspaceFileBytes.mockResolvedValue(null);
    const req = makeRequest("t1", "valid-token");
    const res = await GET(req, { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("file_not_found");
  });

  it("readWorkspaceFileBytes 抛错 → 404 file_not_found", async () => {
    tokenModule.consumeUploadToken.mockReturnValue({
      threadId: "t1",
      workspacePath: "uploads/x.png",
    });
    ws.readWorkspaceFileBytes.mockRejectedValue(new Error("IO error"));
    const req = makeRequest("t1", "valid-token");
    const res = await GET(req, { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("file_not_found");
  });

  it("内部目录路径 → 404 file_not_found（防枚举）", async () => {
    tokenModule.consumeUploadToken.mockReturnValue({
      threadId: "t1",
      workspacePath: ".snow/secrets",
    });
    ws.isInternalPath.mockReturnValue(true);
    const req = makeRequest("t1", "valid-token");
    const res = await GET(req, { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("file_not_found");
    expect(ws.readWorkspaceFileBytes).not.toHaveBeenCalled();
  });
});
