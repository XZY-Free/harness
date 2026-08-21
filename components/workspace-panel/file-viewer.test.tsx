import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileViewer, rawUrl } from "./file-viewer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FileViewer 文件与预览职责", () => {
  it("rawUrl 仍供图片和 PDF 等二进制资源使用", () => {
    expect(rawUrl("t1", "site/index.html")).toBe(
      "/api/v1/threads/t1/workspace/site/index.html?raw=1",
    );
  });

  it("查看 HTML 文件显示源码，不创建 iframe 执行页面", async () => {
    const source = "<!doctype html><html><body><h1>源码标题</h1></body></html>";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { content: source } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<FileViewer threadId="t1" path="index.html" />);

    await waitFor(() => expect(container.querySelector("code")?.textContent).toBe(source));
    expect(container.querySelector("iframe")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/threads/t1/workspace/index.html");
  });
});
