"use client";

import { Icon } from "@/components/icons";
import { useCallback, useEffect, useState } from "react";
import { FileTree } from "./file-tree";
import { FileViewer } from "./file-viewer";
import { PreviewView } from "./preview-view";
import type { WorkspacePanelView } from "./types";

/**
 * V5 工作区产物面板：右侧栏统一容器（已被 V9 阶段 4 WorkbenchPanel 取代，仅保留兼容）。
 *
 * 接收 `activeWorkspaceView` 描述当前打开对象，按 kind 切换 body 渲染：
 * - preview：网页 iframe（沿用 V4 PreviewPanel 行为）
 * - app：占位提示（主流程已切到 WorkbenchPanel 在内置浏览器打开）
 * - file：FileTree + FileViewer（V5-B2 落地），员工可浏览本会话 workspace 中的可展示文件
 * - artifact / progress：后续阶段预留，先 placeholder
 *
 * 标题与操作栏由本组件统一渲染，子视图只关心 body 内容，避免各 kind 重复实现 header。
 */
export function WorkspacePanel({
  view,
  threadId,
  reloadKey,
  onReload,
  onClose,
}: {
  view: WorkspacePanelView;
  threadId: string;
  reloadKey: number;
  onReload: () => void;
  onClose: () => void;
}) {
  // V9 阶段 5：app kind 无 title 字段，需先用 in 检查再访问。
  const title = "title" in view && view.title ? view.title : defaultTitleFor(view);
  const isPreview = view.kind === "preview";
  const canReload = isPreview || view.kind === "file";
  const previewUrl = isPreview ? view.url : null;

  // file kind 的内部选中路径：初始化自 view.path，用户在 FileTree 切换文件时更新本地状态。
  // 不写回 view（避免父级 state 膨胀）；view.path 变化（外部程序化切换）会同步覆盖本地选中。
  const initialPath = view.kind === "file" ? view.path : null;
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
  useEffect(() => {
    setSelectedPath(initialPath);
  }, [initialPath]);
  const handleSelectPath = useCallback((path: string) => setSelectedPath(path), []);

  return (
    <div className="flex h-full flex-col bg-[var(--surface-2)]">
      <header className="flex items-center justify-between gap-2 border-[var(--border)] border-b bg-[var(--surface)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon.preview size={15} className="shrink-0 text-[var(--fg-subtle)]" />
          <span className="truncate text-[13px] font-medium text-[var(--fg)]">
            {view.kind === "file" && selectedPath
              ? (selectedPath.split("/").pop() ?? selectedPath)
              : title}
          </span>
          {previewUrl ? (
            <span className="hidden max-w-[240px] truncate font-mono text-[11px] text-[var(--fg-subtle)] sm:inline">
              {previewUrl}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canReload ? (
            <>
              <button
                type="button"
                onClick={onReload}
                title={isPreview ? "刷新预览" : "刷新文件"}
                aria-label={isPreview ? "刷新预览" : "刷新文件"}
                className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--fg-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
              >
                <Icon.refresh size={13} />
              </button>
              {isPreview && previewUrl ? (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="在新标签打开"
                  aria-label="在新标签打开预览"
                  className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--fg-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
                >
                  <Icon.external size={13} />
                </a>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭工作区"
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--fg-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
          >
            <Icon.close size={14} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {renderBody(view, threadId, reloadKey, selectedPath, handleSelectPath)}
      </div>
    </div>
  );
}

function defaultTitleFor(view: WorkspacePanelView): string {
  switch (view.kind) {
    case "app":
      return "运行页";
    case "preview":
      return "预览";
    case "file":
      return view.path.split("/").pop() || view.path;
    case "artifact":
      return view.title ?? "产物";
    case "progress":
      return view.title ?? "进度";
  }
}

function renderBody(
  view: WorkspacePanelView,
  threadId: string,
  reloadKey: number,
  selectedPath: string | null,
  onSelectPath: (path: string) => void,
) {
  if (view.kind === "app") {
    // V9 阶段 5：主流程已切到 WorkbenchPanel 在内置浏览器打开运行页；
    // 此处仅作兼容占位（如旧 WorkspacePanel 仍被显式渲染时）。
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-[var(--fg-muted)]">
        <span>项目运行页已在右侧「浏览器」页签中打开。</span>
      </div>
    );
  }
  if (view.kind === "preview") {
    return <PreviewView url={view.url} reloadKey={reloadKey} />;
  }
  if (view.kind === "file") {
    // 文件视图：移动端上下排列，桌面端左右排列。
    // 文件树让员工在本会话 workspace 中切换文件；FileViewer 按 path 渲染对应类型。
    return (
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex max-h-[38vh] w-full shrink-0 flex-col border-[var(--border)] border-b bg-[var(--surface)] md:max-h-none md:w-[200px] md:border-r md:border-b-0">
          <FileTree
            key={`${threadId}:${reloadKey}`}
            threadId={threadId}
            selectedPath={selectedPath}
            onSelectPath={onSelectPath}
          />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedPath ? (
            <FileViewer
              key={`${selectedPath}:${reloadKey}`}
              threadId={threadId}
              path={selectedPath}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-[var(--fg-muted)]">
              从左侧选择一个文件查看
            </div>
          )}
        </div>
      </div>
    );
  }
  // Phase C+ 接入 artifact / progress 视图；当前阶段返回空态提示，
  // 避免父组件切换 kind 后 body 出现空白。
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-[var(--fg-muted)]">
      <span>该对象视图将在后续阶段开放。</span>
    </div>
  );
}
