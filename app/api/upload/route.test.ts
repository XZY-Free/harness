import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// P1-3: mock workspace-access(归属校验)+ workspace(写文件)。
// 默认放行;个别用例覆盖为拒绝。
const accessMock = vi.hoisted(() => ({ ok: true as boolean, status: 401 as number }));
vi.mock("@/lib/workspace-access", () => ({
  requireThreadWorkspaceRead: vi.fn().mockImplementation(async () =>
    accessMock.ok
      ? { ok: true, user: { id: "test-user" } }
      : {
          ok: false,
          response: new Response(JSON.stringify({ error: "未授权" }), {
            status: accessMock.status,
            headers: { "content-type": "application/json" },
          }),
        },
  ),
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

import { writeWorkspaceFileBytes } from "@/lib/workspace";
import { requireThreadWorkspaceRead } from "@/lib/workspace-access";

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
    accessMock.ok = true;
    accessMock.status = 401;
    writeMock.throw = false;
    vi.mocked(requireThreadWorkspaceRead).mockClear();
    vi.mocked(writeWorkspaceFileBytes).mockClear();
  });

  it("P1-3: 未鉴权返回 401(归属校验先行)", async () => {
    accessMock.ok = false;
    accessMock.status = 401;

    const res = await POST(uploadRequest(new File(["x"], "a.txt", { type: "text/plain" })));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "未授权" });
  });

  it("P1-3: 缺 threadId → 归属校验拒绝(404)", async () => {
    accessMock.ok = false;
    accessMock.status = 404;

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
    expect(requireThreadWorkspaceRead).toHaveBeenCalledWith(expect.anything(), "test-thread-1");
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

  it("P1-3: 图片存入 workspace/uploads,返回经 workspace 路由的 url", async () => {
    const res = await POST(
      uploadRequest(new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" })),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("image");
    expect(body.url).toContain("/api/threads/test-thread-1/workspace/uploads/");
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
