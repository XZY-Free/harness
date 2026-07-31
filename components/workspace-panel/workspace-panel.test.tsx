import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspacePanel } from "./workspace-panel";

vi.mock("./file-tree", () => ({
  FileTree: () => <div>文件树</div>,
}));

vi.mock("./file-viewer", () => ({
  FileViewer: () => <div>文件内容</div>,
}));

afterEach(() => {
  cleanup();
});

describe("WorkspacePanel 文件视图", () => {
  it("移动端也渲染文件树，不再用 hidden md:flex 把唯一入口藏掉", () => {
    const { container } = render(
      <WorkspacePanel
        view={{ kind: "file", path: "" }}
        threadId="t1"
        reloadKey={0}
        onReload={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("文件树")).not.toBeNull();
    expect(screen.getByRole("button", { name: "刷新文件" })).not.toBeNull();
    const aside = container.querySelector("aside");
    expect(aside?.className).not.toContain("hidden");
    expect(aside?.className).not.toContain("md:flex");
  });
});
