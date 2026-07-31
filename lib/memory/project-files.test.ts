import { describe, expect, it, vi } from "vitest";

const ws = vi.hoisted(() => ({ readWorkspaceFile: vi.fn() }));
vi.mock("@/lib/workspace", () => ({
  readWorkspaceFile: ws.readWorkspaceFile,
  safeJoin: (id: string, p: string) => `${id}/${p}`,
}));

import { loadProjectMemoryFiles } from "./project-files";

/**
 * S1（06-P1-3）：文件级项目记忆加载测试。
 */

describe("loadProjectMemoryFiles（06-P1-3）", () => {
  it("读取 CLAUDE.md 并返回带文件名头的文本", async () => {
    ws.readWorkspaceFile.mockImplementation(async (_id, name) =>
      name === "CLAUDE.md" ? "# 规范\n用 Tailwind + 中文回复" : null,
    );
    const out = await loadProjectMemoryFiles("t1");
    expect(out).toContain("# 项目记忆（CLAUDE.md）");
    expect(out).toContain("用 Tailwind");
  });

  it("无任何项目记忆文件 → 空串（零回归）", async () => {
    ws.readWorkspaceFile.mockResolvedValue(null);
    const out = await loadProjectMemoryFiles("t1");
    expect(out).toBe("");
  });

  it("多文件按优先级拼接（CLAUDE.md + SNOW.md）", async () => {
    ws.readWorkspaceFile.mockImplementation(async (_id, name) => {
      if (name === "CLAUDE.md") return "规则A";
      if (name === "SNOW.md") return "规则B";
      return null;
    });
    const out = await loadProjectMemoryFiles("t1");
    expect(out).toContain("规则A");
    expect(out).toContain("规则B");
    expect(out.indexOf("CLAUDE.md")).toBeLessThan(out.indexOf("SNOW.md"));
  });

  it("超大文件截断到上限", async () => {
    ws.readWorkspaceFile.mockImplementation(async (_id, name) =>
      name === "CLAUDE.md" ? "x".repeat(20_000) : null,
    );
    const out = await loadProjectMemoryFiles("t1");
    expect(out).toContain("已截断");
    expect(out.length).toBeLessThan(20_000);
  });
});
