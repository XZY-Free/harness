import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// V10 Phase 1：Mock PreviewSurface（iframe 预览），不再 mock BrowserPanel
vi.mock("./preview-surface", () => ({
  PreviewSurface: ({
    threadId,
    previewUrl,
    reloadKey,
  }: {
    threadId: string;
    previewUrl: string | null;
    reloadKey: number;
  }) => (
    <div
      data-testid="preview-surface"
      data-thread={threadId}
      data-preview-url={previewUrl ?? ""}
      data-reload-key={reloadKey}
    />
  ),
}));
vi.mock("../desktop/desktop-browser-surface", () => ({
  DesktopBrowserSurface: ({
    threadId,
    initialUrl,
  }: { threadId: string; initialUrl: string | null }) => (
    <div data-testid="desktop-browser-surface" data-thread={threadId} data-url={initialUrl ?? ""} />
  ),
}));
vi.mock("./run-log-panel", () => ({
  RunLogPanel: ({ threadId }: { threadId: string }) => (
    <div data-testid="run-log-panel" data-thread={threadId} />
  ),
}));
vi.mock("./file-tree", () => ({
  FileTree: ({
    selectedPath,
    onSelectPath,
  }: { selectedPath: string | null; onSelectPath: (p: string) => void }) => (
    <div data-testid="file-tree" data-selected={selectedPath}>
      <button type="button" onClick={() => onSelectPath("src/app.js")}>
        app.js
      </button>
    </div>
  ),
}));
vi.mock("./file-editor", () => ({
  FileEditor: ({ threadId, path }: { threadId: string; path: string }) => (
    <div data-testid="file-editor" data-thread={threadId} data-path={path} />
  ),
}));

import { WorkbenchPanel } from "./workbench-panel";

afterEach(() => {
  cleanup();
});

describe("WorkbenchPanel 三页签 (V10 Phase 1: 工作区/预览/运行日志)", () => {
  it("默认渲染工作区页签，含文件树", () => {
    render(
      <WorkbenchPanel
        view={{ kind: "file", path: "index.html" }}
        threadId="t1"
        previewUrl={null}
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("工作区")).toBeTruthy();
    expect(screen.getByText("预览")).toBeTruthy();
    expect(screen.getByText("运行日志")).toBeTruthy();
    // V10：不再有「浏览器」页签
    expect(screen.queryByText("浏览器")).toBeNull();
    expect(screen.getByTestId("file-tree")).toBeTruthy();
  });

  it("点击预览页签切换到 PreviewSurface", () => {
    render(
      <WorkbenchPanel
        view={null}
        threadId="t1"
        previewUrl="/preview/t1/index.html"
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("预览"));
    expect(screen.getByTestId("preview-surface")).toBeTruthy();
    expect(screen.queryByTestId("file-tree")).toBeNull();
  });

  it("点击运行日志页签切换到 RunLogPanel", () => {
    render(
      <WorkbenchPanel
        view={null}
        threadId="t1"
        previewUrl={null}
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("运行日志"));
    expect(screen.getByTestId("run-log-panel")).toBeTruthy();
  });

  it("view.kind=file 时选中对应文件路径", () => {
    render(
      <WorkbenchPanel
        view={{ kind: "file", path: "src/app.js" }}
        threadId="t1"
        previewUrl={null}
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("file-tree").getAttribute("data-selected")).toBe("src/app.js");
    expect(screen.getByTestId("file-editor").getAttribute("data-path")).toBe("src/app.js");
  });

  it("view.kind=app 时切到预览页签，PreviewSurface 收到 previewUrl", () => {
    render(
      <WorkbenchPanel
        view={{ kind: "app" }}
        threadId="t1"
        previewUrl="/preview/t1/index.html"
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("preview-surface")).toBeTruthy();
    expect(screen.queryByTestId("file-tree")).toBeNull();
    expect(screen.getByTestId("preview-surface").getAttribute("data-preview-url")).toBe(
      "/preview/t1/index.html",
    );
  });

  it("view.kind=preview 时也切到预览页签（旧 preview 统一走 iframe）", () => {
    render(
      <WorkbenchPanel
        view={{ kind: "preview", url: "http://localhost:3000" }}
        threadId="t1"
        previewUrl="/preview/t1/"
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("preview-surface")).toBeTruthy();
    expect(screen.queryByTestId("file-tree")).toBeNull();
  });

  it("view.kind=app 显示「刷新预览」按钮，点击递增 reloadKey", () => {
    render(
      <WorkbenchPanel
        view={{ kind: "app" }}
        threadId="t1"
        previewUrl="/preview/t1/index.html"
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    const initialReload = screen.getByTestId("preview-surface").getAttribute("data-reload-key");
    fireEvent.click(screen.getByLabelText("刷新预览"));
    const afterReload = screen.getByTestId("preview-surface").getAttribute("data-reload-key");
    expect(Number(afterReload)).toBeGreaterThan(Number(initialReload));
  });

  it("view.kind 非 app/preview 不显示「刷新预览」按钮", () => {
    render(
      <WorkbenchPanel
        view={{ kind: "file", path: "index.html" }}
        threadId="t1"
        previewUrl={null}
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("刷新预览")).toBeNull();
  });

  it("view=null 时工作区显示选择文件占位，无报错", () => {
    render(
      <WorkbenchPanel
        view={null}
        threadId="t1"
        previewUrl={null}
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("file-tree")).toBeTruthy();
    expect(screen.queryByTestId("file-editor")).toBeNull();
  });

  it("文件树点击切换文件 → FileEditor 收到新路径", () => {
    render(
      <WorkbenchPanel
        view={{ kind: "file", path: "index.html" }}
        threadId="t1"
        previewUrl={null}
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("app.js"));
    expect(screen.getByTestId("file-editor").getAttribute("data-path")).toBe("src/app.js");
  });

  it("关闭按钮触发 onClose", () => {
    const onClose = vi.fn();
    render(
      <WorkbenchPanel
        view={null}
        threadId="t1"
        previewUrl={null}
        reloadKey={0}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText("关闭工作台"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("previewUrl=null 且 view 非 app/preview 时预览页签可切换但 PreviewSurface 收到 null", () => {
    render(
      <WorkbenchPanel
        view={null}
        threadId="t1"
        previewUrl={null}
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("预览"));
    expect(screen.getByTestId("preview-surface").getAttribute("data-preview-url")).toBe("");
  });

  it("Desktop 模式显示浏览器页签并挂载本地 Browser Surface", () => {
    render(
      <WorkbenchPanel
        platform="desktop"
        view={{ kind: "app" }}
        threadId="t1"
        previewUrl="http://localhost:4173"
        reloadKey={0}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("浏览器")).toBeTruthy();
    expect(screen.queryByText("预览")).toBeNull();
    expect(screen.getByTestId("desktop-browser-surface").getAttribute("data-url")).toBe(
      "http://localhost:4173",
    );
  });
});
