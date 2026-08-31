import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsUserRoleManager } from "./settings-user-role-manager";

const users = [
  {
    id: "u-1",
    email: "zhangsan@example.com",
    displayName: "张三",
    externalSubject: "subject-1",
    templateKeys: ["admin"],
  },
  {
    id: "u-2",
    email: "lisi@example.com",
    displayName: "李四",
    externalSubject: "subject-2",
    templateKeys: [],
  },
];
const roles = [
  { key: "admin", name: "管理员", isSystem: true, actions: ["studio.access"] },
  { key: "auditor", name: "审计员", isSystem: true, actions: ["audit.read"] },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsUserRoleManager", () => {
  it("选择用户、勾选角色后才发送覆盖保存请求，并反馈成功状态", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { roleIds: ["auditor"] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <SettingsUserRoleManager currentUserId="u-1" users={users} roles={roles} />,
    );

    expect(view.container.querySelectorAll('[data-slot="studio-settings-group"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-slot="studio-settings-row"]')).toHaveLength(
      roles.length,
    );
    expect(screen.getByRole("heading", { level: 3, name: "用户" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "张三" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /李四/ }));
    expect(screen.getByRole("button", { name: /李四/ }).getAttribute("aria-pressed")).toBe("true");
    const checkbox = screen.getByRole("checkbox", { name: /审计员/ });
    expect(checkbox.getAttribute("data-slot")).toBe("checkbox");
    fireEvent.click(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/studio/api/settings/users/u-2/roles",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ roleIds: ["auditor"] }),
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("已保存");
  });

  it("保存失败用 alert 公告服务端错误消息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: { message: "不能移除最后一个管理员" } }),
      }),
    );
    render(<SettingsUserRoleManager currentUserId="u-1" users={users} roles={roles} />);

    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect((await screen.findByRole("alert")).textContent).toContain("不能移除最后一个管理员");
  });
});
