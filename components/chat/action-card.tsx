import { Icon } from "@/components/icons";
import type { WorkspacePanelView } from "@/components/workspace-panel/types";
import { toolLabel } from "@/lib/i18n";

/** S1（12-P2-1）：ActionCard 子组件类型（从 chat-panel 抽出）。 */
type ToolPart = {
  input?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
};

type IconType = React.ComponentType<{ size?: number }>;

/**
 * V5-C1：从工具 part 推导可打开的工作区产物视图。
 */
function deriveWorkspaceView(toolName: string, part: ToolPart): WorkspacePanelView | null {
  const output = part.output;
  if (!output || output.ok === false) return null;

  const path = typeof output.path === "string" ? output.path : null;
  if (path && (toolName === "writeFile" || toolName === "readFile")) {
    return { kind: "file", path };
  }

  const url = typeof output.url === "string" ? output.url : null;
  if (url && (toolName === "reportReady" || toolName === "startPreview")) {
    // V9 阶段 5：改用 app 视图，在内置浏览器打开运行页（不再用 preview iframe）。
    return { kind: "app" };
  }

  return null;
}

/**
 * V5-C2：按工具类型返回员工可读的失败摘要。
 */
function friendlyFailureMessage(toolName: string): string {
  switch (toolName) {
    case "writeFile":
      return "文件写入失败";
    case "readFile":
    case "readFileRange":
      return "文件读取失败";
    case "runCommand":
      return "命令执行失败";
    case "runTests":
      return "测试运行失败";
    case "reportReady":
      return "预览自检未通过";
    case "startPreview":
      return "预览启动失败";
    case "glob":
    case "listFiles":
      return "文件列表读取失败";
    default:
      return "执行失败";
  }
}

export function ActionCard({
  type,
  part,
  iconMap,
  onOpenWorkspace,
}: {
  type: string;
  part: ToolPart;
  iconMap?: Record<string, IconType>;
  onOpenWorkspace?: (view: WorkspacePanelView) => void;
}) {
  const toolName = type.slice("tool-".length);
  const label = toolLabel(toolName);
  const IconCmp = iconMap?.[toolName];
  const failed = part.output?.ok === false;
  const publicDetail = part.input?.path ?? part.output?.path ?? part.output?.url ?? "";

  const workspaceView = deriveWorkspaceView(toolName, part);
  const openLabel = workspaceView?.kind === "app" ? "打开运行页" : "查看文件";
  const failureMessage = failed ? friendlyFailureMessage(toolName) : null;
  const safeDetail = failed ? (part.input?.path ?? part.output?.path ?? "") : publicDetail;

  // 纯 inline 文字行：图标 + 标签 + 详情 + 箭头/状态
  return (
    <div className="flex items-center gap-2 py-1.5 text-[13px]">
      {/* 状态图标 */}
      <span className="flex size-5 shrink-0 items-center justify-center">
        {failed ? (
          <span className="text-[var(--danger)]">
            <Icon.close size={14} />
          </span>
        ) : IconCmp ? (
          <span className="text-[var(--fg-subtle)]">
            <IconCmp size={14} />
          </span>
        ) : (
          <span className="size-1.5 rounded-full bg-[var(--fg-subtle)]" />
        )}
      </span>

      {/* 标签 */}
      <span className={`font-medium ${failed ? "text-[var(--danger)]" : "text-[var(--fg)]"}`}>
        {label}
      </span>

      {/* 详情（文件路径等） */}
      {safeDetail ? (
        <code className="truncate font-mono text-[12px] text-[var(--fg-muted)]">
          {String(safeDetail)}
        </code>
      ) : null}

      {/* 右侧：失败信息 或 查看按钮 或 箭头 */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {failureMessage ? (
          <span className="text-[12px] text-[var(--danger)]">{failureMessage}</span>
        ) : workspaceView && onOpenWorkspace ? (
          <button
            type="button"
            onClick={() => onOpenWorkspace(workspaceView)}
            className="flex items-center gap-0.5 text-[12px] text-[var(--fg-muted)] transition hover:text-[var(--primary)]"
            aria-label={openLabel}
          >
            {openLabel}
            <Icon.chevron size={12} />
          </button>
        ) : (
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[var(--fg-subtle)]"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </div>
    </div>
  );
}
