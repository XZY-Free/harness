import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FILES = [
  "components/studio/nav.tsx",
  "components/studio/appearance-setting.tsx",
  "components/studio/settings-user-role-manager.tsx",
  "components/studio/studio-page.tsx",
  "components/studio/studio-settings-section.tsx",
] as const;

const CLIENT_API_COMPONENTS = [
  "governance-editor.tsx",
  "permission-rules-editor.tsx",
  "settings-user-role-manager.tsx",
  "skill-creator.tsx",
  "skill-delete-button.tsx",
  "skill-file-editor.tsx",
  "skill-sync-button.tsx",
  "skill-sync-meta.tsx",
  "skill-version-timeline.tsx",
] as const;

describe("Studio 新界面组件合同", () => {
  it.each(FILES)("%s 使用语义 token 与项目 UI 组件", (file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(source).not.toMatch(/var\(--(?:fg|bg|surface|accent-soft|accent-fg|danger-soft)\)/);
    expect(source).not.toMatch(/text-\[\d+(?:\.\d+)?px\]/);
    expect(source).not.toMatch(/rounded-\[var\(--radius/);
  });

  it("导航与外观设置不再使用旧手绘图标", () => {
    const nav = readFileSync(resolve(process.cwd(), "components/studio/nav.tsx"), "utf8");
    const appearance = readFileSync(
      resolve(process.cwd(), "components/studio/appearance-setting.tsx"),
      "utf8",
    );
    expect(nav).not.toContain("@/components/icons");
    expect(appearance).not.toContain("<svg");
    expect(appearance).not.toContain("@/components/icons");
  });

  it("角色管理使用 Button 与 Checkbox，不手写基础控件", () => {
    const source = readFileSync(
      resolve(process.cwd(), "components/studio/settings-user-role-manager.tsx"),
      "utf8",
    );
    expect(source).toContain("@/components/ui/button");
    expect(source).toContain("@/components/ui/checkbox");
    expect(source).not.toContain('<input type="checkbox"');
  });

  it.each(CLIENT_API_COMPONENTS)("%s 通过统一入口请求应用 API", (file) => {
    const source = readFileSync(resolve(process.cwd(), "components/studio", file), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).toContain("apiFetch");
  });
});
