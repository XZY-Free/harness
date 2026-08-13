import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/icons", () => ({
  Icon: new Proxy({}, { get: () => () => null }),
}));
vi.mock("./file-viewer", () => ({
  FileViewer: ({ path }: { path: string }) => (
    <div data-testid="file-viewer-fallback" data-path={path} />
  ),
}));

import { FileEditor } from "./file-editor";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetch(opts: {
  content?: string;
  revision?: string;
  ok?: boolean;
  status?: number;
  conflict?: boolean;
}) {
  const {
    content = "hello world",
    revision = "11:1783569464",
    ok = true,
    status = 200,
    conflict = false,
  } = opts;
  const fn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    // PUT 写入
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body as string);
      if (conflict || (body.revision && body.revision !== revision)) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            ok: false,
            error: {
              code: "revision_conflict",
              currentRevision: revision,
              currentContent: "AI changed",
            },
          }),
        };
      }
      const newRev = "15:1783569500";
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { path: url, stat: { revision: newRev } } }),
      };
    }
    // GET 读取
    if (!ok) {
      return { ok: false, status, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { content, stat: { revision } },
      }),
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("FileEditor 可编辑编辑器 (V9 阶段 4)", () => {
  it("加载文件内容 + 行号", async () => {
    mockFetch({ content: "line1\nline2\nline3", revision: "rev1" });
    render(<FileEditor threadId="t1" path="src/app.js" />);
    await waitFor(() => {
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(ta.value).toBe("line1\nline2\nline3");
    });
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("修改内容后约 1s 自动保存（PUT 带 revision）", async () => {
    const fn = mockFetch({ content: "old", revision: "rev1" });
    render(<FileEditor threadId="t1" path="src/app.js" />);
    await waitFor(() => expect(screen.getByDisplayValue("old")).toBeTruthy());

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "new content" } });

    await waitFor(
      () => {
        const putCall = fn.mock.calls.find((c) => c[1]?.method === "PUT");
        expect(putCall).toBeTruthy();
        const body = JSON.parse(putCall?.[1].body as string);
        expect(body.content).toBe("new content");
        expect(body.revision).toBe("rev1");
      },
      { timeout: 3000 },
    );
  });

  it("冲突（409）→ 显示冲突面板 + merge 按钮，不静默覆盖", async () => {
    mockFetch({ content: "user draft", revision: "stale-rev", conflict: true });
    render(<FileEditor threadId="t1" path="src/app.js" />);
    await waitFor(() => expect(screen.getByDisplayValue("user draft")).toBeTruthy());

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "user edit" } });

    await waitFor(
      () => {
        expect(screen.getByText(/文件已被外部修改/)).toBeTruthy();
      },
      { timeout: 3000 },
    );
    expect(screen.getByText("采用远端版本")).toBeTruthy();
    expect(screen.getByText("保留我的改动并重新保存")).toBeTruthy();
  });

  it("Cmd/Ctrl+S 立即保存", async () => {
    const fn = mockFetch({ content: "old", revision: "rev1" });
    render(<FileEditor threadId="t1" path="src/app.js" />);
    await waitFor(() => expect(screen.getByDisplayValue("old")).toBeTruthy());

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "saved" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });

    await waitFor(
      () => {
        const putCall = fn.mock.calls.find((c) => c[1]?.method === "PUT");
        expect(putCall).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("图片文件回退只读 FileViewer", () => {
    mockFetch({ content: "" });
    render(<FileEditor threadId="t1" path="logo.png" />);
    expect(screen.getByTestId("file-viewer-fallback").getAttribute("data-path")).toBe("logo.png");
  });

  it("文件不存在 → 错误提示", async () => {
    mockFetch({ ok: false, status: 404 });
    render(<FileEditor threadId="t1" path="missing.txt" />);
    await waitFor(() => {
      expect(screen.getByText("文件不存在")).toBeTruthy();
    });
  });

  it("无改动不触发自动保存", async () => {
    const fn = mockFetch({ content: "nochange", revision: "rev1" });
    render(<FileEditor threadId="t1" path="src/app.js" />);
    await waitFor(() => expect(screen.getByDisplayValue("nochange")).toBeTruthy());
    // 等待超过自动保存延迟，确认无 PUT
    await new Promise((r) => setTimeout(r, 1400));
    const putCall = fn.mock.calls.find((c) => c[1]?.method === "PUT");
    expect(putCall).toBeUndefined();
  });
});
