import type { PermissionManagementView } from "@/lib/identity/permission-management";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "./permission-manager";
vi.mock("@/lib/api-fetch", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "@/lib/api-fetch";
const initial: PermissionManagementView = {
  defaults: { mode: "all", version: 0, inheritedAssets: [] },
  tenantId: "t",
  agents: [],
  users: [
    {
      id: "u",
      principalId: "p",
      displayName: "测试员工",
      email: "u@example.test",
      status: "active",
    },
  ],
  groups: [],
  assignments: [],
  roles: [
    {
      key: "admin",
      name: "平台管理员",
      isSystem: true,
      version: 1,
      grants: [{ actionCode: "user.manage", resourceScope: { type: "tenant", wildcard: true } }],
    },
    { key: "member", name: "普通员工", isSystem: true, version: 1, grants: [] },
  ],
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("成员与权限管理", () => {
  it("显示默认员工身份，普通员工不是需要逐人勾选的角色", () => {
    render(<PermissionManager initial={initial} currentUserId="u" />);
    expect(screen.getByText(/普通员工 · 默认/)).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
  it("保存正式角色分配并携带旧版本，失败保持编辑态", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "内容已变化，请刷新" } }), { status: 409 }),
    );
    render(<PermissionManager initial={initial} currentUserId="u" />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(await screen.findByText("内容已变化，请刷新")).toBeTruthy();
    expect(vi.mocked(apiFetch).mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        operation: "set_roles",
        principalId: "p",
        roleKeys: ["admin"],
        expectedRoleKeys: [],
      }),
    );
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });
  it("从现有区域进入用户组和角色，不新建顶层权限页面", () => {
    render(<PermissionManager initial={initial} currentUserId="u" />);
    fireEvent.click(screen.getByRole("tab", { name: "用户组" }));
    expect(screen.getByRole("button", { name: "新建用户组" })).toBeTruthy();
  });
});
