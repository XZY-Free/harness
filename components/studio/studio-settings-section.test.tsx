import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  StudioSettingsLinkRow,
  StudioSettingsRow,
  StudioSettingsSection,
} from "./studio-settings-section";

afterEach(cleanup);

describe("StudioSettingsSection 设置分组", () => {
  it("用一个轻量分组承载多行设置，标题说明在左、控件在右", () => {
    render(
      <StudioSettingsSection title="权限" description="管理后台访问范围。">
        <StudioSettingsRow title="默认权限" description="成员进入后台后的默认范围。">
          <Switch aria-label="默认权限" />
        </StudioSettingsRow>
        <StudioSettingsRow title="角色模板" description="给用户分配权限模板。">
          <Button variant="outline">管理</Button>
        </StudioSettingsRow>
      </StudioSettingsSection>,
    );

    const region = screen.getByRole("region", { name: "权限" });
    expect(region.querySelector('[data-slot="studio-settings-group"]')).not.toBeNull();
    expect(region.querySelectorAll('[data-slot="studio-settings-row"]')).toHaveLength(2);
    expect(screen.getByText("管理后台访问范围。")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "默认权限" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "管理" })).toBeTruthy();
  });

  it("链接行保留可访问名称、真实目标与统一行结构", () => {
    render(
      <StudioSettingsSection title="安全">
        <StudioSettingsLinkRow
          href="/studio/audit"
          title="操作记录"
          description="查看后台敏感操作。"
        />
      </StudioSettingsSection>,
    );

    const link = screen.getByRole("link", { name: /操作记录/ });
    expect(link.getAttribute("href")).toBe("/studio/audit");
    expect(link.getAttribute("data-slot")).toBe("studio-settings-row");
  });
});
