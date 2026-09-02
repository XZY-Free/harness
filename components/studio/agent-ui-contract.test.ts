import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS = [
  "agent-registration-workspace.tsx",
  "agents-viewer.tsx",
  "agent-contract-registration-panel.tsx",
  "agent-contract-panel.tsx",
  "agent-revision-section.tsx",
  "agent-revision-actions.tsx",
] as const;

function source(file: (typeof COMPONENTS)[number]): string {
  return readFileSync(resolve(process.cwd(), "components/studio", file), "utf8");
}

describe("Studio 智能体主链界面合同", () => {
  it.each(COMPONENTS)("%s 使用语义 token，不再引用旧样式变量", (file) => {
    const contents = source(file);
    expect(contents).not.toMatch(
      /var\(--(?:fg|fg-muted|fg-subtle|surface|surface-2|danger|border|radius)\)/,
    );
    expect(contents).not.toMatch(/text-\[\d+(?:\.\d+)?px\]/);
    expect(contents).not.toMatch(/rounded-\[var\(--radius/);
  });

  it("所有可操作控件都复用项目 UI 组件", () => {
    const registration = source("agent-contract-registration-panel.tsx");
    const viewer = source("agents-viewer.tsx");
    const section = source("agent-revision-section.tsx");
    const revisions = source("agent-revision-actions.tsx");

    expect(registration).toContain("@/components/ui/button");
    expect(registration).toContain("@/components/ui/input");
    expect(viewer).toContain("@/components/ui/button");
    expect(section).toContain("@/components/ui/select");
    expect(revisions).toContain("@/components/ui/button");
    expect(revisions).toContain("@/components/ui/select");
    expect(revisions).toContain("@/components/ui/textarea");

    for (const contents of [registration, viewer, section, revisions]) {
      expect(contents).not.toMatch(/<(?:button|select|textarea)\b/);
    }
    expect(registration).not.toMatch(/<input\b/);
  });

  it("智能体与版本表格在窄窗口可横向滚动", () => {
    expect(source("agents-viewer.tsx")).toContain("overflow-x-auto");
    expect(source("agent-revision-actions.tsx")).toContain("overflow-x-auto");
  });
});
