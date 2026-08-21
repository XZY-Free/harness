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

const writeMock = vi.hoisted(() => ({ throw: false as boolean }));
vi.mock("@/lib/workspace", () => ({
  writeWorkspaceFileBytes: vi.fn().mockImplementation(async () => {
    if (writeMock.throw) throw new Error("disk full");
  }),
}));

const pdf = vi.hoisted(() => ({
  destroy: vi.fn(),
}));

const office = vi.hoisted(() => ({
  parseOffice: vi.fn(),
}));

vi.mock("pdf-parse", () => ({
  PDFParse: class {
    async getText() {
      return { text: "PDF body", total: 2 };
    }

    async destroy() {
      pdf.destroy();
    }
  },
}));

vi.mock("officeparser", () => ({
  parseOffice: office.parseOffice,
}));

import { AuthenticationError } from "@/lib/identity/resolver";
import { writeWorkspaceFileBytes } from "@/lib/workspace";

function uploadRequest(file: File, threadId = "test-thread-1"): Request {
  const body = new FormData();
  body.set("file", file);
  body.set("threadId", threadId);
  return new Request("http://localhost/api/upload", {
    method: "POST",
    body,
  });
}

describe("POST /api/upload", () => {
  afterEach(() => {
    pdf.destroy.mockClear();
    office.parseOffice.mockReset();
    writeMock.throw = false;
    vi.mocked(writeWorkspaceFileBytes).mockClear();
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
  });

  it("P1-3: 未鉴权返回 401(归属校验先行)", async () => {
    authMock.resolveEmployeePrincipal.mockRejectedValue(
      new AuthenticationError("missing_identity", "缺少身份"),
    );

    const res = await POST(uploadRequest(new File(["x"], "a.txt", { type: "text/plain" })));

    expect(res.status).toBe(401);
  });

  it("P1-3: 缺 threadId / 非 owner → 归属校验拒绝(404)", async () => {
    authMock.getThreadById.mockResolvedValue({
      id: "test-thread-1",
      tenantId: "tenant-1",
      ownerUserId: "other-user",
      lifecycleState: "active",
    });

    const res = await POST(uploadRequest(new File(["x"], "a.txt", { type: "text/plain" })));

    expect(res.status).toBe(404);
  });

  it("归属校验通过,解析纯文本文档", async () => {
    const res = await POST(uploadRequest(new File(["hello"], "note.txt", { type: "text/plain" })));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      kind: "document",
      filename: "note.txt",
      engine: "native",
      text: "hello",
      charCount: 5,
    });
    expect(authMock.getThreadById).toHaveBeenCalledWith("tenant-1", "test-thread-1");
  });

  it("PDF 使用 PDFParse.getText 并释放 parser", async () => {
    const res = await POST(
      uploadRequest(new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" })),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      kind: "document",
      filename: "brief.pdf",
      engine: "pdf-parse",
    });
    expect(body.text).toContain("页数: 2");
    expect(body.text).toContain("PDF body");
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });

  it("Office 文档使用 parseOffice 返回 AST 文本", async () => {
    office.parseOffice.mockResolvedValue({
      toText: () => "Office body",
    });

    const res = await POST(
      uploadRequest(
        new File(["docx"], "proposal.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      kind: "document",
      filename: "proposal.docx",
      engine: "officeparser",
      text: "Office body",
      charCount: 11,
    });
    expect(office.parseOffice).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it("P1-3: 图片存入 workspace/uploads,返回经 workspace v1 路由的 url", async () => {
    const res = await POST(
      uploadRequest(new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" })),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("image");
    expect(body.url).toContain("/api/v1/threads/test-thread-1/workspace/uploads/");
    expect(body.url).toContain("?raw=1");
    expect(writeWorkspaceFileBytes).toHaveBeenCalledWith(
      "test-thread-1",
      expect.stringMatching(/^uploads\/[0-9a-f-]+\.png$/),
      expect.any(Buffer),
    );
  });

  it("P1-3: 图片写盘失败 → 500", async () => {
    writeMock.throw = true;

    const res = await POST(
      uploadRequest(new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" })),
    );

    expect(res.status).toBe(500);
  });
});
