/**
 * V5：原 `components/preview-panel.tsx` 迁入工作区面板内部，作为 preview kind 的视图。
 *
 * 仅渲染 iframe 主体——标题栏与刷新/新窗口/关闭操作由父级 `WorkspacePanel` 统一渲染，
 * 避免不同 kind 各自维护一套 header 样式。仅当父级确认 preview 已 ready 时挂载。
 */
export function PreviewView({ url, reloadKey }: { url: string; reloadKey: number }) {
  return (
    <div className="relative min-h-0 flex-1 bg-[var(--surface-2)]">
      <iframe
        key={reloadKey}
        src={url}
        title="项目预览"
        className="h-full w-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
