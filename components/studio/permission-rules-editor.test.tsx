import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PermissionRulesEditor } from "./permission-rules-editor";

const initialRules = [
  {
    id: "rule-1",
    ruleKey: "filesystem-safe-write",
    toolPattern: "filesystem.write",
    argMatcher: { pathRegex: "^/workspace/" },
    decision: "pause" as const,
    scope: { type: "tenant", ref: "tenant-1" },
    priority: 20,
    reason: "写入前需要确认",
  },
];

function renderEditor(canWrite = true) {
  return render(
    <PermissionRulesEditor
      initialDefaultDecision="block"
      initialRules={initialRules}
      initialVersionNo={3}
      canWrite={canWrite}
      revisionNo={6}
      publishedAt="2026-08-31T02:00:00.000Z"
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PermissionRulesEditor", () => {
  it("使用轻分组 shadcn 表单保存完整规则 payload，并携带 If-Match", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "etag" ? "4" : null) },
      json: async () => ({
        ok: true,
        data: {
          revision: { revisionNo: 7, publishedAt: "2026-08-31T03:00:00.000Z" },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderEditor();

    expect(view.container.querySelector("table")).toBeNull();
    expect(view.container.querySelectorAll('[data-slot="studio-settings-group"]')).toHaveLength(2);
    expect(view.container.querySelectorAll('[data-slot="input"]')).toHaveLength(4);
    expect(view.container.querySelectorAll('[data-slot="select-trigger"]')).toHaveLength(2);
    expect(screen.queryByText(/ETag|revision|rev\s*6/i)).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "规则名称" }), {
      target: { value: "filesystem-reviewed-write" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "优先级" }), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/studio/api/permission-rules",
      expect.objectContaining({
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": "3",
        },
        body: JSON.stringify({
          defaultDecision: "block",
          rules: [
            {
              ruleKey: "filesystem-reviewed-write",
              toolPattern: "filesystem.write",
              argMatcher: { pathRegex: "^/workspace/" },
              decision: "pause",
              scope: { type: "tenant", ref: "tenant-1" },
              priority: 30,
              reason: "写入前需要确认",
            },
          ],
        }),
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("规则已保存");
    expect(document.body.textContent).not.toContain("revision 7");
  });

  it("按真实成功信封刷新保存时间，后续保存使用响应 ETag", async () => {
    const nextPublishedAt = "2026-08-31T03:00:00.000Z";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "etag" ? '"4"' : null) },
        json: async () => ({
          ok: true,
          data: { revision: { revisionNo: 7, publishedAt: nextPublishedAt } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "etag" ? "5" : null) },
        json: async () => ({
          ok: true,
          data: {
            revision: { revisionNo: 8, publishedAt: "2026-08-31T04:00:00.000Z" },
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));

    await waitFor(() => {
      expect(screen.getByText(/^最近保存：/).textContent).toContain(
        new Date(nextPublishedAt).toLocaleString("zh-CN"),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ "If-Match": "4" }),
      }),
    );
  });

  it("失败时显示 error.message，绝不出现 [object Object]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ error: { message: "工具匹配范围无效" } }),
      }),
    );
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("工具匹配范围无效");
    expect(alert.textContent).not.toContain("[object Object]");
  });

  it("412 并发冲突要求刷新，不覆盖其他管理员刚保存的规则", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 412 }));
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("其他管理员已更新");
    expect(alert.textContent).toContain("刷新");
  });

  it("只读用户只看到中文规则摘要，不能新增、删除、编辑或保存", () => {
    renderEditor(false);

    expect(screen.getByText("仅可查看")).toBeTruthy();
    expect(screen.getByText("默认处理方式")).toBeTruthy();
    expect(screen.getByText("阻止执行")).toBeTruthy();
    expect(screen.getByText("写入前需要确认")).toBeTruthy();
    expect(screen.getByText("路径匹配")).toBeTruthy();
    expect(screen.getByText("^/workspace/")).toBeTruthy();
    expect(screen.getByText("当前租户")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).not.toMatch(/ETag|revision|rev\s*6/i);
    expect(document.body.textContent).not.toMatch(/pathRegex|tenant-1|\{"type"/);
  });
});
