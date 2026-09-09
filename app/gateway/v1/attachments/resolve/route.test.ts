import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/files/agent-attachment-access", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/files/agent-attachment-access")>();
  return { ...original, readAgentAttachment: accessMock.read };
});

import { AgentAttachmentAccessError } from "@/lib/files/agent-attachment-access";
import { POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/gateway/v1/attachments/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /gateway/v1/attachments/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.read.mockResolvedValue({
      content: Buffer.from([1, 2, 3]),
      originalFilename: "证明.pdf",
      contentType: "application/pdf",
    });
  });

  it("凭短期 reference_id 返回原文件且不暴露 Provider 引用", async () => {
    const response = await POST(request({ reference_id: "123e4567-e89b-12d3-a456-426614174000" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E8%AF%81%E6%98%8E.pdf",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    expect(accessMock.read).toHaveBeenCalledWith("123e4567-e89b-12d3-a456-426614174000");
  });

  it.each([
    null,
    {},
    { reference_id: "" },
    { reference_id: "not-a-uuid" },
    { reference_id: "------------------------------------" },
    { reference_id: "123e4567-e89b-12d3-a456-426614174000", extra: true },
  ])("非法请求体返回 400，且不读取文件", async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(accessMock.read).not.toHaveBeenCalled();
  });

  it("未知、过期或撤销的引用统一隐藏为 404", async () => {
    accessMock.read.mockRejectedValue(
      new AgentAttachmentAccessError("attachment_unavailable", "附件引用不存在或不可用"),
    );

    const response = await POST(request({ reference_id: "123e4567-e89b-12d3-a456-426614174000" }));

    expect(response.status).toBe(404);
  });

  it("当前部署无法读取记录对应 Provider 时返回 503", async () => {
    accessMock.read.mockRejectedValue(
      new AgentAttachmentAccessError("storage_unavailable", "附件存储暂不可用"),
    );

    const response = await POST(request({ reference_id: "123e4567-e89b-12d3-a456-426614174000" }));

    expect(response.status).toBe(503);
  });
});
