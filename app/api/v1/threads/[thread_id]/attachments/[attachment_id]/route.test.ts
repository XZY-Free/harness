import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  resolveEmployeePrincipal: vi.fn(),
  getThreadById: vi.fn(),
}));
vi.mock("@/lib/conversations/route-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/conversations/route-helpers")>();
  return { ...original, resolveEmployeePrincipal: authMock.resolveEmployeePrincipal };
});
vi.mock("@/lib/conversations/thread-queries", () => ({
  getThreadById: authMock.getThreadById,
}));

const attachmentMock = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock("@/lib/workspace/workspace-queries", () => ({
  getWorkspaceAttachmentById: attachmentMock.getById,
}));

const storageMock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/files/storage-bootstrap", () => ({
  getFileStorageProvider: vi.fn(async () => ({
    name: "test-storage",
    store: vi.fn(),
    read: storageMock.read,
    delete: vi.fn(),
  })),
}));

import { AuthenticationError } from "@/lib/identity/resolver";
import { GET } from "./route";

function request() {
  return new Request("http://localhost/api/v1/threads/thread-1/attachments/attachment-1");
}

const context = {
  params: Promise.resolve({ thread_id: "thread-1", attachment_id: "attachment-1" }),
};

describe("GET /api/v1/threads/:threadId/attachments/:attachmentId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.resolveEmployeePrincipal.mockResolvedValue({
      tenantId: "tenant-1",
      userIdentityId: "owner-1",
    });
    authMock.getThreadById.mockResolvedValue({
      id: "thread-1",
      ownerUserId: "owner-1",
      lifecycleState: "active",
    });
    attachmentMock.getById.mockResolvedValue({
      id: "attachment-1",
      tenantId: "tenant-1",
      threadId: "thread-1",
      storageProvider: "test-storage",
      resourceType: "file",
      resourceRef: "opaque-ref-1",
      resourceFingerprint:
        "sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      originalFilename: "证明材料.pdf",
      contentType: "application/pdf",
      sizeBytes: 4,
      attachmentState: "attached",
      expiresAt: null,
    });
    storageMock.read.mockResolvedValue(Buffer.from([1, 2, 3, 4]));
  });

  it("Provider 字节与登记大小或指纹不一致时拒绝返回", async () => {
    storageMock.read.mockResolvedValue(Buffer.from([9, 9, 9, 9]));

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
  });

  it("所属用户通过 attachmentId 读取 Provider 中的原文件", async () => {
    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E8%AF%81%E6%98%8E%E6%9D%90%E6%96%99.pdf",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(storageMock.read).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      threadId: "thread-1",
      resourceRef: "opaque-ref-1",
    });
  });

  it("未登录时不读取附件", async () => {
    authMock.resolveEmployeePrincipal.mockRejectedValue(
      new AuthenticationError("missing_identity", "缺少身份"),
    );

    const response = await GET(request(), context);

    expect(response.status).toBe(401);
    expect(storageMock.read).not.toHaveBeenCalled();
  });

  it("非 Thread 所有人返回隐藏式 404", async () => {
    authMock.getThreadById.mockResolvedValue({
      id: "thread-1",
      ownerUserId: "other-user",
      lifecycleState: "active",
    });

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    expect(attachmentMock.getById).not.toHaveBeenCalled();
    expect(storageMock.read).not.toHaveBeenCalled();
  });

  it.each([
    ["其他 Thread", { threadId: "thread-2" }],
    ["已卸载", { attachmentState: "detached" }],
    ["已过期", { expiresAt: new Date("2020-01-01T00:00:00.000Z") }],
  ])("%s 的附件拒绝读取", async (_label, override) => {
    attachmentMock.getById.mockResolvedValue({
      ...(await attachmentMock.getById()),
      ...override,
    });

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    expect(storageMock.read).not.toHaveBeenCalled();
  });

  it("当前部署没有登记记录所需的 Provider 时明确失败", async () => {
    attachmentMock.getById.mockResolvedValue({
      ...(await attachmentMock.getById()),
      storageProvider: "enterprise-cos",
    });

    const response = await GET(request(), context);

    expect(response.status).toBe(503);
    expect(storageMock.read).not.toHaveBeenCalled();
  });
});
