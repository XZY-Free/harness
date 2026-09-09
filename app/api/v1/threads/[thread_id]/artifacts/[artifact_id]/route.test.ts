import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ resolveEmployeePrincipal: vi.fn() }));
vi.mock("@/lib/conversations/route-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/conversations/route-helpers")>();
  return { ...original, resolveEmployeePrincipal: authMock.resolveEmployeePrincipal };
});
const threadMock = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock("@/lib/conversations/thread-queries", () => ({ getThreadById: threadMock.getById }));
const artifactMock = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock("@/lib/capability/artifact-queries", () => ({ getArtifactById: artifactMock.getById }));
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

const context = {
  params: Promise.resolve({ thread_id: "thread-1", artifact_id: "artifact-1" }),
};
const request = () => new Request("http://localhost/api/v1/threads/thread-1/artifacts/artifact-1");

describe("GET /api/v1/threads/:threadId/artifacts/:artifactId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.resolveEmployeePrincipal.mockResolvedValue({
      tenantId: "tenant-1",
      userIdentityId: "owner-1",
    });
    threadMock.getById.mockResolvedValue({
      id: "thread-1",
      ownerUserId: "owner-1",
      lifecycleState: "active",
    });
    artifactMock.getById.mockResolvedValue({
      id: "artifact-1",
      threadId: "thread-1",
      storageProvider: "test-storage",
      contentRef: "opaque-artifact-ref",
      displayName: "结果.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 4,
      contentHash: "sha256:ee10da4aefe61a37df1dee937ca3221afa3b2351f9ea34edbbb769573c6785f7",
      expiresAt: null,
    });
    storageMock.read.mockResolvedValue(Buffer.from([4, 3, 2, 1]));
  });

  it("所属用户读取统一 Provider 中的 AI 最终文件", async () => {
    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E7%BB%93%E6%9E%9C.xlsx",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([4, 3, 2, 1]));
  });

  it("未登录时返回 401", async () => {
    authMock.resolveEmployeePrincipal.mockRejectedValue(
      new AuthenticationError("missing_identity", "缺少身份"),
    );
    expect((await GET(request(), context)).status).toBe(401);
    expect(storageMock.read).not.toHaveBeenCalled();
  });

  it.each([
    ["非 owner", { thread: { ownerUserId: "other-user" } }],
    ["其他 Thread", { artifact: { threadId: "thread-2" } }],
    ["已过期", { artifact: { expiresAt: new Date("2020-01-01T00:00:00.000Z") } }],
  ])("%s 的产物隐藏为 404", async (_label, override) => {
    if ("thread" in override) {
      threadMock.getById.mockResolvedValue({
        ...(await threadMock.getById()),
        ...override.thread,
      });
    }
    if ("artifact" in override) {
      artifactMock.getById.mockResolvedValue({
        ...(await artifactMock.getById()),
        ...override.artifact,
      });
    }
    expect((await GET(request(), context)).status).toBe(404);
    expect(storageMock.read).not.toHaveBeenCalled();
  });

  it("当前 Provider 不匹配时返回 503", async () => {
    artifactMock.getById.mockResolvedValue({
      ...(await artifactMock.getById()),
      storageProvider: "enterprise-cos",
    });
    expect((await GET(request(), context)).status).toBe(503);
    expect(storageMock.read).not.toHaveBeenCalled();
  });
});
