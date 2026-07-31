import { describe, expect, it } from "vitest";
import { isRunFinished, selectArtifactView } from "./artifact-select";

/**
 * V5-D1：会话产物选择规则测试。
 *
 * 覆盖 7 条规则 + 边界（空数组 / previewUrl 优先 / 大小写 / 排序稳定性）。
 */

describe("selectArtifactView V5-D1", () => {
  it("1. previewUrl 存在 → app 视图（最高优先级，覆盖一切文件；V9 阶段 5 改为内置浏览器打开）", () => {
    const view = selectArtifactView({
      files: ["README.md", "index.html", "app.js"],
      previewUrl: "/preview/t1/",
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "app" });
  });

  it("2. README.md → file 视图（优先于其它 md）", () => {
    const view = selectArtifactView({
      files: ["docs/intro.md", "README.md", "index.html"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "README.md" });
  });

  it("2b. README.markdown 也识别", () => {
    const view = selectArtifactView({
      files: ["README.markdown", "src/app.js"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "README.markdown" });
  });

  it("2c. readme.md 大小写不敏感", () => {
    const view = selectArtifactView({
      files: ["readme.md", "src/app.js"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "readme.md" });
  });

  it("3. 无 README，有其它 md → 取字母序首个 md", () => {
    const view = selectArtifactView({
      files: ["docs/guide.md", "notes.md", "index.html"],
      threadId: "t1",
    });
    // docs/guide.md < notes.md（按完整路径字母序）
    expect(view).toEqual({ kind: "file", path: "docs/guide.md" });
  });

  it("4. 无 md，有 index.html → file 视图（沙盒预览静态页面）", () => {
    const view = selectArtifactView({
      files: ["src/app.js", "index.html", "styles.css"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "index.html" });
  });

  it("4b. 嵌套 index.html（如 src/index.html）也识别", () => {
    const view = selectArtifactView({
      files: ["src/index.html", "package.json"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "src/index.html" });
  });

  it("5. 无 md/html，有 pdf → file 视图", () => {
    const view = selectArtifactView({
      files: ["report.pdf", "data.csv"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "report.pdf" });
  });

  it("5b. 多个 pdf → 取字母序首个", () => {
    const view = selectArtifactView({
      files: ["z-report.pdf", "a-report.pdf"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "a-report.pdf" });
  });

  it("6. 只有代码 / 配置 → file 视图但 path=''（打开文件列表不预选）", () => {
    const view = selectArtifactView({
      files: ["src/app.js", "package.json", "tsconfig.json"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "" });
  });

  it("7. 无文件 → null（右侧保持空态）", () => {
    const view = selectArtifactView({
      files: [],
      threadId: "t1",
    });
    expect(view).toBeNull();
  });

  it("边界：files 含 . 开头隐藏文件 → 过滤后无可见 → null", () => {
    const view = selectArtifactView({
      files: [".env", ".gitignore"],
      threadId: "t1",
    });
    expect(view).toBeNull();
  });

  it("边界：previewUrl 优先于 README", () => {
    const view = selectArtifactView({
      files: ["README.md"],
      previewUrl: "/preview/t1/",
      threadId: "t1",
    });
    expect(view?.kind).toBe("app");
  });

  it("边界：空字符串路径被过滤", () => {
    const view = selectArtifactView({
      files: ["", "README.md"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "README.md" });
  });

  it("综合：md + html + pdf + 代码 → README 优先（即使没列首位）", () => {
    const view = selectArtifactView({
      files: ["app.js", "report.pdf", "index.html", "README.md"],
      threadId: "t1",
    });
    expect(view).toEqual({ kind: "file", path: "README.md" });
  });
});

describe("isRunFinished V5-D1", () => {
  it("submitted → false（流式启动中）", () => {
    expect(isRunFinished("submitted")).toBe(false);
  });

  it("streaming → false（流式输出中）", () => {
    expect(isRunFinished("streaming")).toBe(false);
  });

  it("ready_for_review → true（reportReady 成功）", () => {
    expect(isRunFinished("ready_for_review")).toBe(true);
  });

  it("idle → true（run 结束回到空闲）", () => {
    expect(isRunFinished("idle")).toBe(true);
  });

  it("executing → false（agent 执行中，不应扫旧文件自动选产物）", () => {
    expect(isRunFinished("executing")).toBe(false);
  });

  it("failed → true（run 失败，可触发选择让员工看已生成部分）", () => {
    expect(isRunFinished("failed")).toBe(true);
  });
});
