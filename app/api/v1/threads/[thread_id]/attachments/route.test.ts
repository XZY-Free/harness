import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// 鉴权 mock：正式 Employee 身份 + Thread.owner 归属（不再依赖已删的 workspace-access）。
// 默认放行（owner 命中）；个别用例覆盖为拒绝/非 owner。
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

const storageMock = vi.hoisted(() => ({
  throwOnStore: false as boolean,
  store: vi.fn(),
  read: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/files/storage-bootstrap", () => ({
  getFileStorageProvider: vi.fn(async () => ({
    name: "test-storage",
    store: storageMock.store,
    read: storageMock.read,
    delete: storageMock.delete,
  })),
}));

const attachmentRepositoryMock = vi.hoisted(() => ({
  create: vi.fn(),
}));
vi.mock("@/lib/files/commit-managed-attachment", () => ({
  commitManagedWorkspaceAttachment: attachmentRepositoryMock.create,
}));

const idempotencyMock = vi.hoisted(() => ({
  enforce: vi.fn(),
  fail: vi.fn(),
  prepareRetry: vi.fn(),
}));
vi.mock("@/lib/identity/idempotency", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/identity/idempotency")>();
  return {
    ...original,
    enforceIdempotency: idempotencyMock.enforce,
    failRecord: idempotencyMock.fail,
    prepareRetryForFailedRecord: idempotencyMock.prepareRetry,
  };
});

import { AuthenticationError } from "@/lib/identity/resolver";

const originalImageUploadMaxMb = process.env.SNOW_FILE_IMAGE_UPLOAD_MAX_MB;

function uploadRequest(file: File, idempotencyKey: string | null = "upload-test-1"): Request {
  const body = new FormData();
  body.set("file", file);
  return new Request("http://localhost/api/v1/threads/test-thread-1/attachments", {
    method: "POST",
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    body,
  });
}

const context = { params: Promise.resolve({ thread_id: "test-thread-1" }) };

describe("POST /api/v1/threads/:threadId/attachments", () => {
  afterEach(() => {
    process.env.SNOW_FILE_IMAGE_UPLOAD_MAX_MB = originalImageUploadMaxMb;
    storageMock.throwOnStore = false;
    storageMock.store.mockReset();
    storageMock.read.mockReset();
    storageMock.delete.mockReset();
    attachmentRepositoryMock.create.mockReset();
    idempotencyMock.enforce.mockReset();
    idempotencyMock.fail.mockReset();
    idempotencyMock.prepareRetry.mockReset();
  });

  beforeEach(() => {
    // 默认：员工身份命中 owner，thread 存在且 active。
    authMock.resolveEmployeePrincipal.mockResolvedValue({
      tenantId: "tenant-1",
      userIdentityId: "owner-1",
    });
    authMock.getThreadById.mockResolvedValue({
      id: "test-thread-1",
      tenantId: "tenant-1",
      ownerUserId: "owner-1",
      lifecycleState: "active",
    });
    storageMock.store.mockImplementation(async (input: { resourceId: string }) => {
      if (storageMock.throwOnStore) throw new Error("disk full");
      return { resourceRef: `.snow/files/attachment/${input.resourceId}/content` };
    });
    storageMock.delete.mockResolvedValue(true);
    attachmentRepositoryMock.create.mockImplementation(async (input: Record<string, unknown>) => ({
      ...input,
      attachmentState: "attached",
    }));
    idempotencyMock.enforce.mockResolvedValue({
      kind: "new",
      record: { id: "idempotency-record-1" },
    });
    idempotencyMock.fail.mockResolvedValue(undefined);
  });

  it("缺少 Idempotency-Key 时在读取上传正文前拒绝", async () => {
    const request = uploadRequest(new File(["x"], "a.txt", { type: "text/plain" }), null);
    const formDataSpy = vi.spyOn(request, "formData");

    const res = await POST(request, context);

    expect(res.status).toBe(400);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(storageMock.store).not.toHaveBeenCalled();
  });

  it("过长 Idempotency-Key 时在读取上传正文前拒绝", async () => {
    const request = uploadRequest(
      new File(["x"], "a.txt", { type: "text/plain" }),
      "k".repeat(257),
    );
    const formDataSpy = vi.spyOn(request, "formData");

    const res = await POST(request, context);

    expect(res.status).toBe(400);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(storageMock.store).not.toHaveBeenCalled();
  });

  it("同键同文件重放已有响应，不重复保存文件", async () => {
    idempotencyMock.enforce.mockResolvedValue({
      kind: "replay",
      record: {
        id: "idempotency-record-1",
        processingState: "completed",
        httpStatus: 201,
        responseRef: "attachment-existing",
        responseRedactedJson: JSON.stringify({
          kind: "attachment",
          attachment_id: "attachment-existing",
          url: "/api/v1/threads/test-thread-1/attachments/attachment-existing",
          filename: "a.txt",
          size: 1,
          type: "text/plain",
        }),
      },
    });

    const res = await POST(
      uploadRequest(new File(["x"], "a.txt", { type: "text/plain" })),
      context,
    );

    expect(res.status).toBe(201);
    expect((await res.json()).attachment_id).toBe("attachment-existing");
    expect(storageMock.store).not.toHaveBeenCalled();
    expect(attachmentRepositoryMock.create).not.toHaveBeenCalled();
  });

  it("同一 Idempotency-Key 对应不同文件时拒绝冲突", async () => {
    idempotencyMock.enforce.mockResolvedValue({
      kind: "conflict",
      existingRecord: {
        id: "idempotency-record-1",
        idempotencyKey: "upload-test-1",
        commandScope: "thread.attachment.create:test-thread-1",
        requestHash: "different-hash",
      },
    });

    const res = await POST(
      uploadRequest(new File(["y"], "other.txt", { type: "text/plain" })),
      context,
    );

    expect(res.status).toBe(409);
    expect(storageMock.store).not.toHaveBeenCalled();
    expect(attachmentRepositoryMock.create).not.toHaveBeenCalled();
  });

  it("P1-3: 未鉴权返回 401(归属校验先行)", async () => {
    authMock.resolveEmployeePrincipal.mockRejectedValue(
      new AuthenticationError("missing_identity", "缺少身份"),
    );

    const res = await POST(
      uploadRequest(new File(["x"], "a.txt", { type: "text/plain" })),
      context,
    );

    expect(res.status).toBe(401);
  });

  it("P1-3: 缺 threadId / 非 owner → 归属校验拒绝(404)", async () => {
    authMock.getThreadById.mockResolvedValue({
      id: "test-thread-1",
      tenantId: "tenant-1",
      ownerUserId: "other-user",
      lifecycleState: "active",
    });

    const request = uploadRequest(new File(["x"], "a.txt", { type: "text/plain" }));
    const formDataSpy = vi.spyOn(request, "formData");

    const res = await POST(request, context);

    expect(res.status).toBe(404);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["图片", new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" })],
    ["PDF", new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" })],
    [
      "Office 文档",
      new File(["docx"], "proposal.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ],
    ["纯文本文档", new File(["hello"], "note.txt", { type: "text/plain" })],
  ])("%s 保存原始字节，不在上传接口解析内容", async (_label, file) => {
    const res = await POST(uploadRequest(file), context);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      kind: "attachment",
      filename: file.name,
      size: file.size,
      type: file.type,
    });
    expect(body.attachment_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toBe(`/api/v1/threads/test-thread-1/attachments/${body.attachment_id}`);
    expect(body).not.toHaveProperty("engine");
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("charCount");
    expect(storageMock.store).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      ownerUserId: "owner-1",
      threadId: "test-thread-1",
      resourceId: body.attachment_id,
      resourceKind: "attachment",
      originalFilename: file.name,
      contentType: file.type,
      content: Buffer.from(await file.arrayBuffer()),
    });
    expect(attachmentRepositoryMock.create).toHaveBeenCalledWith(
      {
        id: body.attachment_id,
        tenantId: "tenant-1",
        threadId: "test-thread-1",
        storageProvider: "test-storage",
        resourceRef: `.snow/files/attachment/${body.attachment_id}/content`,
        resourceFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        originalFilename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        attachedBy: "owner-1",
      },
      {
        recordId: "idempotency-record-1",
        responseBody: expect.objectContaining({ attachment_id: body.attachment_id }),
      },
    );
    expect(authMock.getThreadById).toHaveBeenCalledWith("tenant-1", "test-thread-1");
  });

  it("P1-3: 原文件写盘失败 → 500", async () => {
    storageMock.throwOnStore = true;

    const res = await POST(
      uploadRequest(new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" })),
      context,
    );

    expect(res.status).toBe(500);
    expect(attachmentRepositoryMock.create).not.toHaveBeenCalled();
    expect(storageMock.delete).not.toHaveBeenCalled();
  });

  it("使用部署配置的图片上传上限", async () => {
    process.env.SNOW_FILE_IMAGE_UPLOAD_MAX_MB = "1";

    const res = await POST(
      uploadRequest(
        new File([new Uint8Array(1024 * 1024 + 1)], "large.png", { type: "image/png" }),
      ),
      context,
    );

    expect(res.status).toBe(400);
    expect(storageMock.store).not.toHaveBeenCalled();
  });

  it("原始文件名超过元数据上限时在写入前拒绝", async () => {
    const res = await POST(
      uploadRequest(new File(["x"], `${"a".repeat(509)}.txt`, { type: "text/plain" })),
      context,
    );

    expect(res.status).toBe(400);
    expect(storageMock.store).not.toHaveBeenCalled();
  });

  it("附件事实登记失败时删除刚保存的原文件", async () => {
    attachmentRepositoryMock.create.mockRejectedValue(new Error("database unavailable"));

    const res = await POST(
      uploadRequest(new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" })),
      context,
    );

    expect(res.status).toBe(500);
    const storedInput = storageMock.store.mock.calls[0]?.[0] as { resourceId: string };
    expect(storageMock.delete).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      threadId: "test-thread-1",
      resourceRef: `.snow/files/attachment/${storedInput.resourceId}/content`,
    });
  });
});
