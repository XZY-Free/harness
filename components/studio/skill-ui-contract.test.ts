import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS = [
  "components/studio/prompt-diff.tsx",
  "components/studio/skill-creator.tsx",
  "components/studio/skill-delete-button.tsx",
  "components/studio/skill-file-editor.tsx",
  "components/studio/skill-sync-button.tsx",
  "components/studio/skill-sync-meta.tsx",
  "components/studio/skill-version-timeline.tsx",
] as const;

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

describe("技能后台界面合同", () => {
  it.each(COMPONENTS)("%s 使用语义颜色与项目 UI 组件", (file) => {
    const content = source(file);
    expect(content).not.toMatch(/var\(--(?:fg|bg|surface|accent-soft|accent-fg|danger-soft)\)/);
    expect(content).not.toMatch(/text-\[\d+(?:\.\d+)?px\]/);
    expect(content).not.toMatch(/rounded-\[var\(--radius/);
    expect(content).not.toContain("<button");
  });

  it("创建与文件编辑使用项目 Input、Textarea 和 Dialog", () => {
    const creator = source("components/studio/skill-creator.tsx");
    const editor = source("components/studio/skill-file-editor.tsx");
    expect(creator).toContain("@/components/ui/dialog");
    expect(creator).toContain("@/components/ui/input");
    expect(creator).toContain("@/components/ui/textarea");
    expect(editor).toContain("@/components/ui/textarea");
    expect(creator).not.toContain("<input");
    expect(creator).not.toContain("<textarea");
    expect(editor).not.toContain("<textarea");
  });

  it("列表和详情接入统一页面与设置分组，表格容器允许横向滚动", () => {
    const list = source("app/studio/skills/page.tsx");
    const detail = source("app/studio/skills/[id]/page.tsx");
    expect(list).toContain("<StudioPage");
    expect(list).toContain("overflow-x-auto");
    expect(list).toContain('data-slot="skills-empty-state"');
    expect(list).toContain("skills.length === 0 ?");
    expect(detail).toContain("<StudioPage");
    expect(detail).toContain("<StudioSettingsSection");
  });

  it("读取与写入权限仍由服务端控制，同步技能保持只读", () => {
    const list = source("app/studio/skills/page.tsx");
    const detail = source("app/studio/skills/[id]/page.tsx");
    expect(list).toContain('requireStudioPagePermission("skill.read")');
    expect(list).toContain('hasStudioAction(gate.principal, "skill.write")');
    expect(detail).toContain('requireStudioPagePermission("skill.read")');
    expect(detail).toContain('hasStudioAction(gate.principal, "skill.write")');
    expect(detail).toContain("const effectiveCanWrite = canWrite && !isSynced");
    expect(detail).toContain("canWrite={effectiveCanWrite}");
  });

  it("不在界面暴露开发命令、外部系统名或版本存储细节", () => {
    const joined = [
      source("app/studio/skills/page.tsx"),
      source("app/studio/skills/[id]/page.tsx"),
      ...COMPONENTS.map(source),
    ].join("\n");
    expect(joined).not.toContain("pnpm db:seed");
    expect(joined).not.toContain("同步 capability-market");
    expect(joined).not.toContain(">Prompt Diff<");
    expect(joined).not.toContain(">远端资产 ID<");
    expect(joined).not.toContain(">内容 hash<");
    expect(joined).not.toContain(">name（");
    expect(joined).not.toMatch(/instanceof Error \? \w+\.message/);
  });
});
