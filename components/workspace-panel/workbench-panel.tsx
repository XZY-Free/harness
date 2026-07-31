"use client";

import { DesktopBrowserSurface } from "@/components/desktop/desktop-browser-surface";
/**
 * V10 Phase 1：三页签工作台（Web 端）。
 *
 * 三页签：工作区 / 预览 / 运行日志
 * - 工作区：FileTree + 可编辑 FileEditor（自动保存 + 冲突检测）
 * - 预览：PreviewSurface（iframe 加载 /preview/{threadId}/...，含工具栏）
 * - 运行日志：AppRuntime 日志 + ThreadRun 事件
 *
 * view 路由：
 * - view.kind === "file" → 切到工作区页签并选中该文件
 * - view.kind === "app" → 切到预览页签（AppRuntime ready 后打开 Preview）
 * - view.kind === "preview" → 切到预览页签（旧 preview 统一走 iframe）
 * - 其它 → 默认工作区页签
 *
 * V10 变更：
 * - 删除 BrowserPanel（V9 远程浏览器），替换为 PreviewSurface（iframe）
 * - 删除 openAppSignal（不再需要触发 /browser/open-app）
 * - 新增 previewUrl prop（从 session.preview.url 传入）
 * - 新增 previewReloadKey（点击「刷新预览」递增）
 */
import { Icon } from "@/components/icons";
import { useCallback, useEffect, useState } from "react";
import { FileEditor } from "./file-editor";
import { FileTree } from "./file-tree";
import { PreviewSurface } from "./preview-surface";
import { RunLogPanel } from "./run-log-panel";
import type { WorkspacePanelView } from "./types";

type TabKind = "workspace" | "browser" | "preview" | "runlog";

export function WorkbenchPanel({
  view,
  threadId,
  previewUrl,
  reloadKey,
  platform = "web",
  userId,
  onClose,
}: {
  view: WorkspacePanelView | null;
  threadId: string;
  previewUrl: string | null;
  reloadKey: number;
  platform?: "web" | "desktop";
  userId?: string;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<TabKind>("workspace");
  // 工作区选中的文件路径（view.kind === "file" 时初始化，用户在 FileTree 切换时更新）
  const initialPath = view?.kind === "file" ? view.path : null;
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
  // 预览页签的本地刷新 key（点击「刷新预览」递增，触发 iframe 重新挂载）
  const [previewReloadKey, setPreviewReloadKey] = useState(0);

  // 外部 view 变化时同步：
  // - file → 切工作区页签并选中文件
  // - app/preview → 切预览页签
  useEffect(() => {
    if (view?.kind === "file") {
      setActiveTab("workspace");
      setSelectedPath(view.path);
    } else if (view?.kind === "app" || view?.kind === "preview") {
      setActiveTab(platform === "desktop" ? "browser" : "preview");
    }
  }, [platform, view]);

  const handleSelectPath = useCallback((path: string) => setSelectedPath(path), []);
  const handleRefreshPreview = useCallback(() => setPreviewReloadKey((k) => k + 1), []);

  return (
    <div className="flex h-full flex-col bg-[var(--surface-2)]">
      {/* 页签栏 */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-[var(--border)] border-b bg-[var(--surface)] px-2">
        <div className="flex items-center gap-0.5">
          <TabButton
            active={activeTab === "workspace"}
            onClick={() => setActiveTab("workspace")}
            icon={<Icon.briefcase size={13} />}
            label="工作区"
          />
          {platform === "desktop" ? (
            <TabButton
              active={activeTab === "browser"}
              onClick={() => setActiveTab("browser")}
              icon={<Icon.preview size={13} />}
              label="浏览器"
            />
          ) : (
            <TabButton
              active={activeTab === "preview"}
              onClick={() => setActiveTab("preview")}
              icon={<Icon.preview size={13} />}
              label="预览"
            />
          )}
          <TabButton
            active={activeTab === "runlog"}
            onClick={() => setActiveTab("runlog")}
            icon={<Icon.terminal size={13} />}
            label="运行日志"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1 py-1.5">
          {platform === "web" && (view?.kind === "app" || view?.kind === "preview") && (
            <button
              type="button"
              onClick={handleRefreshPreview}
              title="刷新预览"
              aria-label="刷新预览"
              className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
            >
              <Icon.refresh size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭工作台"
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          >
            <Icon.close size={14} />
          </button>
        </div>
      </header>

      {/* 页签主体 */}
      <div className="flex h-full flex-1 flex-col">
        {activeTab === "workspace" && (
          <WorkspaceBody
            threadId={threadId}
            reloadKey={reloadKey}
            selectedPath={selectedPath}
            onSelectPath={handleSelectPath}
          />
        )}
        {activeTab === "preview" && (
          <PreviewSurface
            threadId={threadId}
            previewUrl={previewUrl}
            reloadKey={previewReloadKey}
          />
        )}
        {activeTab === "browser" && platform === "desktop" && (
          <DesktopBrowserSurface
            threadId={threadId}
            userId={userId ?? threadId}
            initialUrl={previewUrl}
          />
        )}
        {activeTab === "runlog" && <RunLogPanel threadId={threadId} />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium transition ${
        active
          ? "bg-[var(--surface-2)] text-[var(--fg)]"
          : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
      }`}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      {label}
    </button>
  );
}

function WorkspaceBody({
  threadId,
  reloadKey,
  selectedPath,
  onSelectPath,
}: {
  threadId: string;
  reloadKey: number;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  // 文件树 + 编辑器：移动端上下排列，桌面端左右排列
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
          <FileEditor
            key={`${selectedPath}:${reloadKey}`}
            threadId={threadId}
            path={selectedPath}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-[var(--fg-muted)]">
            从左侧选择一个文件编辑
          </div>
        )}
      </div>
    </div>
  );
}
