import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GovernanceEditor } from "./governance-editor";

const initialConfig = {
  protectedPaths: ["/workspace/.env"],
  commandDenyList: ["rm -rf"],
  formatOnWrite: false,
  verifyBeforeDelivery: true,
  harnessLoopLimits: {
    maxLoopSteps: 12,
    maxAgentCalls: 3,
    maxToolCalls: 8,
    maxKnowledgeSearches: 6,
    maxConsecutiveSameAction: 2,
  },
};

function renderEditor(canWrite = true) {
  return render(
    <GovernanceEditor
      initialConfig={initialConfig}
      initialVersionNo={7}
      canWrite={canWrite}
      revisionNo={12}
      publishedAt="2026-08-31T02:00:00.000Z"
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GovernanceEditor", () => {
  it("使用轻分组 shadcn 控件保存完整配置，并把当前版本放进 If-Match", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "etag" ? "8" : null) },
      json: async () => ({
        ok: true,
        data: {
          revision: { revisionNo: 13, publishedAt: "2026-08-31T03:00:00.000Z" },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderEditor();

    expect(view.container.querySelectorAll('[data-slot="studio-settings-group"]')).toHaveLength(2);
    expect(view.container.querySelectorAll('[data-slot="textarea"]')).toHaveLength(2);
    expect(view.container.querySelectorAll('[data-slot="checkbox"]')).toHaveLength(2);
    expect(screen.queryByText(/ETag|revision|rev\s*12/i)).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "受保护路径" }), {
      target: { value: "/workspace/src\n/workspace/.env" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "禁止执行的命令" }), {
      target: { value: "rm -rf\ndd" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "写入前自动格式化" }));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/studio/api/governance",
      expect.objectContaining({
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": "7",
        },
        body: JSON.stringify({
          config: {
            protectedPaths: ["/workspace/src", "/workspace/.env"],
            commandDenyList: ["rm -rf", "dd"],
            formatOnWrite: true,
            verifyBeforeDelivery: true,
            harnessLoopLimits: {
              maxLoopSteps: 12,
              maxAgentCalls: 3,
              maxToolCalls: 8,
              maxKnowledgeSearches: 6,
              maxConsecutiveSameAction: 2,
            },
          },
        }),
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("配置已保存");
    expect(document.body.textContent).not.toContain("revision 13");
  });

  it("保留用户输入的空行，只在保存时清理空白行", () => {
    renderEditor();
    const textarea = screen.getByRole("textbox", {
      name: "受保护路径",
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/workspace/.env\n" } });
    expect(textarea.value).toBe("/workspace/.env\n");

    fireEvent.change(textarea, {
      target: { value: "/workspace/.env\n\n/workspace/src" },
    });
    expect(textarea.value).toBe("/workspace/.env\n\n/workspace/src");
  });

  it("按真实成功信封刷新保存时间，后续保存使用响应 ETag", async () => {
    const nextPublishedAt = "2026-08-31T03:00:00.000Z";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "etag" ? 'W/"8"' : null) },
        json: async () => ({
          ok: true,
          data: { revision: { revisionNo: 13, publishedAt: nextPublishedAt } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "etag" ? "9" : null) },
        json: async () => ({
          ok: true,
          data: {
            revision: { revisionNo: 14, publishedAt: "2026-08-31T04:00:00.000Z" },
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      expect(screen.getByText(/^最近保存：/).textContent).toContain(
        new Date(nextPublishedAt).toLocaleString("zh-CN"),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ "If-Match": "8" }),
      }),
    );
  });

  it("失败时读取标准错误信封的 message，绝不渲染对象字符串", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "受保护路径格式不正确" } }),
      }),
    );
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("受保护路径格式不正确");
    expect(alert.textContent).not.toContain("[object Object]");
  });

  it("412 并发冲突要求刷新，不覆盖其他管理员刚保存的配置", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 412 });
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("其他管理员已更新");
    expect(alert.textContent).toContain("刷新");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("只读用户只能查看中文配置摘要，不出现任何编辑或保存控件", () => {
    renderEditor(false);

    expect(screen.getByText("仅可查看")).toBeTruthy();
    expect(screen.getByText("/workspace/.env")).toBeTruthy();
    expect(screen.getByText("交付前校验")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存配置" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/ETag|revision|rev\s*12/i);
  });
});
