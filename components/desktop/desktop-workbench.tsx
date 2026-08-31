"use client";

import { DesktopBrowserSurface } from "@/components/desktop/desktop-browser-surface";
import { Button } from "@/components/ui/button";
import { FileEditor } from "@/components/workspace-panel/file-editor";
import { FileTree } from "@/components/workspace-panel/file-tree";
import { WorkspaceFileIcon } from "@/components/workspace-panel/workspace-file-icon";
import { deriveTaskStatus } from "@/lib/client/derive-task-status";
import type { ClientGoal, ClientItem, ClientTurn } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  FileText,
  Files,
  Plus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type WorkbenchTab = "task" | "files" | "review" | "browser";
type AuxiliaryWorkbenchTab = Exclude<WorkbenchTab, "task">;

type ReviewItem = {
  readonly itemId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly targetPath: string | null;
  readonly diff: string | null;
  readonly pending: boolean;
};

type ArtifactItem = {
  readonly itemId: string;
  readonly displayName: string;
};

const MIN_WORKBENCH_WIDTH = 320;
const MIN_CHAT_WIDTH = 420;
const AUXILIARY_TABS: readonly {
  readonly id: AuxiliaryWorkbenchTab;
  readonly label: string;
  readonly Icon: typeof Files;
}[] = [
  { id: "files", label: "文件", Icon: Files },
  { id: "review", label: "审阅", Icon: FileText },
  { id: "browser", label: "浏览器", Icon: CircleDot },
];

interface DesktopWorkbenchProps {
  readonly threadId: string;
  /** 由桌面标题栏控制显隐；关闭时不保留窄轨道。 */
  readonly isOpen?: boolean;
  /** Desktop Browser 的会话归属身份；由服务端路由传入，避免把 ThreadId 当身份使用。 */
  readonly viewerId?: string;
  readonly threadTitle?: string | null;
  readonly activeGoal: ClientGoal | null;
  readonly latestTurn: ClientTurn | null;
  readonly items: readonly ClientItem[];
  /** 将工作台中的确认或产物定位到共同时间线，不在右侧复制执行入口。 */
  readonly onLocateItem: (itemId: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function collectReviews(items: readonly ClientItem[]): ReviewItem[] {
  return items.flatMap((item) => {
    if (item.item_type !== "user_action" || item.item_state === "superseded") return [];
    const content = asRecord(item.content);
    if (!content || content.request_type !== "confirmation") return [];
    return [
      {
        itemId: item.id,
        title: readText(content, "title") ?? "需要确认的操作",
        summary: readText(content, "summary", "reason"),
        targetPath: readText(content, "target_path"),
        diff: readText(content, "diff"),
        pending:
          typeof content.state === "string"
            ? content.state === "pending"
            : item.item_state === "pending",
      },
    ];
  });
}

function collectArtifacts(items: readonly ClientItem[]): ArtifactItem[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    if (item.item_type !== "artifact" || item.item_state === "superseded") return [];
    const content = asRecord(item.content);
    const artifactId = content ? readText(content, "artifact_id") : null;
    const key = artifactId ?? item.id;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        itemId: item.id,
        displayName: content
          ? (readText(content, "display_name", "title", "name") ?? "未命名产物")
          : "未命名产物",
      },
    ];
  });
}

function maxWorkbenchWidth(workbench: HTMLElement | null): number {
  const containerWidth =
    workbench?.parentElement?.getBoundingClientRect().width || window.innerWidth;
  return Math.max(MIN_WORKBENCH_WIDTH, containerWidth - MIN_CHAT_WIDTH);
}

function getAuxiliaryTab(tab: AuxiliaryWorkbenchTab) {
  const definition = AUXILIARY_TABS.find((candidate) => candidate.id === tab);
  if (!definition) throw new Error(`未知工作台页签：${tab}`);
  return definition;
}

function tabLabel(tab: WorkbenchTab): string {
  return tab === "task" ? "输出内容" : getAuxiliaryTab(tab).label;
}

function TabIcon({ tab }: { tab: AuxiliaryWorkbenchTab }) {
  const { Icon } = getAuxiliaryTab(tab);
  return <Icon className="size-3.5" strokeWidth={1.5} />;
}

export function DesktopWorkbench({
  threadId,
  isOpen = true,
  viewerId,
  threadTitle,
  activeGoal,
  latestTurn,
  items,
  onLocateItem,
}: DesktopWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("task");
  const [openTabs, setOpenTabs] = useState<Set<WorkbenchTab>>(() => new Set(["task"]));
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [width, setWidth] = useState(368);
  const [isResizing, setIsResizing] = useState(false);

  const reviews = useMemo(() => collectReviews(items), [items]);
  const artifacts = useMemo(() => collectArtifacts(items), [items]);
  const pendingReviews = reviews.filter((review) => review.pending);
  const hasTaskContent = pendingReviews.length > 0 || artifacts.length > 0;
  const selectedReview =
    reviews.find((review) => review.itemId === selectedReviewId) ?? reviews[0] ?? null;
  const taskStatus = deriveTaskStatus(latestTurn);
  const taskTitle = activeGoal?.objective ?? threadTitle ?? "当前任务";

  useEffect(() => {
    if (!selectedReviewId && reviews[0]) setSelectedReviewId(reviews[0].itemId);
  }, [reviews, selectedReviewId]);

  const openTab = useCallback((tab: AuxiliaryWorkbenchTab) => {
    setOpenTabs((current) => new Set([...current, tab]));
    setActiveTab(tab);
    setLauncherOpen(false);
  }, []);

  const closeTab = useCallback((tab: AuxiliaryWorkbenchTab) => {
    setOpenTabs((current) => {
      const next = new Set(current);
      next.delete(tab);
      return next;
    });
    setActiveTab((current) => (current === tab ? "task" : current));
  }, []);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setIsResizing(true);
      const startX = event.clientX;
      const startWidth = width;
      const maxWidth = maxWorkbenchWidth(event.currentTarget.parentElement?.parentElement ?? null);
      const onPointerMove = (moveEvent: PointerEvent) => {
        setWidth(
          Math.min(
            maxWidth,
            Math.max(MIN_WORKBENCH_WIDTH, startWidth - (moveEvent.clientX - startX)),
          ),
        );
      };
      const stopResize = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        window.removeEventListener("blur", stopResize);
        setIsResizing(false);
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopResize, { once: true });
      window.addEventListener("pointercancel", stopResize, { once: true });
      window.addEventListener("blur", stopResize, { once: true });
    },
    [width],
  );

  const visibleTabs = Array.from(openTabs);

  return (
    <aside
      aria-label="任务工作台"
      aria-hidden={!isOpen}
      className={cn(
        "relative flex h-full shrink-0 overflow-hidden bg-background transition-[width] duration-200 ease-out",
        isOpen ? "p-3 pl-0" : "p-0",
      )}
      style={{ width: isOpen ? width : 0 }}
    >
      <div
        className={cn(
          "flex h-full min-w-[320px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-[opacity,transform] duration-200 ease-out",
          isOpen ? "translate-x-0 opacity-100" : "translate-x-2 opacity-0",
        )}
      >
        <div
          role="separator"
          aria-label="调整工作台宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_WORKBENCH_WIDTH}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowLeft" ? 16 : -16;
            setWidth((current) => {
              const maxWidth = maxWorkbenchWidth(
                event.currentTarget.parentElement?.parentElement ?? null,
              );
              return Math.min(maxWidth, Math.max(MIN_WORKBENCH_WIDTH, current + direction));
            });
          }}
          className="absolute top-0 -left-1 z-10 h-full w-2 cursor-col-resize"
        />
        <div
          role="tablist"
          aria-label="工作台页签"
          className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3"
        >
          {visibleTabs.map((tab) => (
            <div key={tab} className="group flex min-w-0 items-center">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls={`workbench-${tab}`}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-sm transition-colors",
                  activeTab === tab
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {tab !== "task" && <TabIcon tab={tab} />}
                <span className="truncate">{tabLabel(tab)}</span>
                {tab === "review" && pendingReviews.length > 0 && (
                  <span className="rounded-full bg-warning/15 px-1.5 text-2xs text-warning">
                    {pendingReviews.length}
                  </span>
                )}
              </button>
              {tab !== "task" && (
                <button
                  type="button"
                  aria-label={`关闭${tabLabel(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab);
                  }}
                  className="-ml-1 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                >
                  <X className="size-3.5" strokeWidth={1.5} />
                </button>
              )}
            </div>
          ))}
          <div className="relative ml-auto">
            <button
              type="button"
              aria-label="打开工作台功能"
              aria-haspopup="menu"
              aria-expanded={launcherOpen}
              onClick={() => setLauncherOpen((open) => !open)}
              className="flex size-8 items-center justify-center rounded-xl bg-muted/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Plus className="size-4" strokeWidth={1.5} />
            </button>
            {launcherOpen && (
              <div
                role="menu"
                aria-label="工作台功能"
                className="absolute top-9 right-0 z-20 w-44 rounded-lg border border-border bg-popover p-1 shadow-lg"
              >
                {AUXILIARY_TABS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    onClick={() => openTab(id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground hover:bg-muted"
                  >
                    <TabIcon tab={id} />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div
          id={`workbench-${activeTab}`}
          role="tabpanel"
          className="min-h-0 flex-1 overflow-hidden"
        >
          {activeTab === "task" &&
            (hasTaskContent ? (
              <TaskPane
                taskTitle={taskTitle}
                statusLabel={taskStatus.label}
                statusTone={taskStatus.tone}
                reviews={pendingReviews}
                artifacts={artifacts}
                onLocateItem={onLocateItem}
              />
            ) : (
              <EmptyTaskPane
                onOpenFiles={() => openTab("files")}
                onOpenReview={() => openTab("review")}
                onOpenBrowser={() => openTab("browser")}
              />
            ))}
          {activeTab === "files" && (
            <FilesPane
              threadId={threadId}
              selectedPath={selectedPath}
              onSelectPath={setSelectedPath}
            />
          )}
          {activeTab === "review" && (
            <ReviewPane
              review={selectedReview}
              reviews={reviews}
              onSelect={setSelectedReviewId}
              onLocateItem={onLocateItem}
            />
          )}
          {activeTab === "browser" && (
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col pl-2">
              {viewerId ? (
                <DesktopBrowserSurface
                  threadId={threadId}
                  userId={viewerId}
                  initialUrl={null}
                  suspendNativeView={isResizing || !isOpen}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-muted-foreground text-sm">
                  浏览器需要当前员工身份，无法在此会话中打开。
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function TaskPane({
  taskTitle,
  statusLabel,
  statusTone,
  reviews,
  artifacts,
  onLocateItem,
}: {
  readonly taskTitle: string;
  readonly statusLabel: string;
  readonly statusTone: ReturnType<typeof deriveTaskStatus>["tone"];
  readonly reviews: readonly ReviewItem[];
  readonly artifacts: readonly ArtifactItem[];
  readonly onLocateItem: (itemId: string) => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <section className="rounded-xl bg-muted/55 p-3.5">
        <p className="text-2xs text-muted-foreground">当前任务</p>
        <h2 className="mt-1 font-medium text-foreground text-sm">{taskTitle}</h2>
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              statusTone === "running" && "animate-gentle-pulse bg-primary",
              statusTone === "waiting" && "bg-warning",
              statusTone === "success" && "bg-success",
              statusTone === "error" && "bg-destructive",
              (statusTone === "stopped" || statusTone === "idle") && "bg-muted-foreground",
            )}
          />
          {statusLabel}
        </div>
      </section>

      <section className="mt-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-foreground text-sm">待确认</h3>
          {reviews.length > 0 && (
            <span className="text-2xs text-muted-foreground">{reviews.length} 项</span>
          )}
        </div>
        {reviews.length > 0 ? (
          <div className="mt-2 space-y-2">
            {reviews.map((review) => (
              <button
                key={review.itemId}
                type="button"
                onClick={() => onLocateItem(review.itemId)}
                className="flex w-full items-start gap-2 rounded-lg border border-border p-3 text-left transition hover:bg-muted"
              >
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-warning" strokeWidth={1.5} />
                <span className="min-w-0">
                  <span className="block truncate text-foreground text-sm">{review.title}</span>
                  {review.summary && (
                    <span className="mt-1 block line-clamp-2 text-muted-foreground text-xs">
                      {review.summary}
                    </span>
                  )}
                </span>
                <ChevronRight
                  className="mt-0.5 ml-auto size-3.5 shrink-0 text-muted-foreground"
                  strokeWidth={1.5}
                />
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="mt-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-foreground text-sm">会话产物</h3>
          {artifacts.length > 0 && (
            <span className="text-2xs text-muted-foreground">{artifacts.length} 个</span>
          )}
        </div>
        {artifacts.length > 0 ? (
          <div className="mt-2 space-y-1">
            {artifacts.map((artifact) => (
              <button
                key={artifact.itemId}
                type="button"
                onClick={() => onLocateItem(artifact.itemId)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground hover:bg-muted"
              >
                <WorkspaceFileIcon
                  name={artifact.displayName}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="truncate">{artifact.displayName}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function EmptyTaskPane({
  onOpenFiles,
  onOpenReview,
  onOpenBrowser,
}: {
  readonly onOpenFiles: () => void;
  readonly onOpenReview: () => void;
  readonly onOpenBrowser: () => void;
}) {
  const actions = {
    files: onOpenFiles,
    review: onOpenReview,
    browser: onOpenBrowser,
  };

  return (
    <div className="flex h-full items-center justify-center px-5" aria-label="空任务快捷入口">
      <div className="w-36 space-y-1">
        {AUXILIARY_TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-label={`打开${label}`}
            onClick={actions[id]}
            className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon className="size-3.5" strokeWidth={1.5} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FilesPane({
  threadId,
  selectedPath,
  onSelectPath,
}: {
  readonly threadId: string;
  readonly selectedPath: string | null;
  readonly onSelectPath: (path: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-40 shrink-0 flex-col border-r border-border">
        <FileTree threadId={threadId} selectedPath={selectedPath} onSelectPath={onSelectPath} />
      </div>
      <div className="min-w-0 flex-1">
        {selectedPath ? (
          <FileEditor threadId={threadId} path={selectedPath} />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-sm">
            从左侧选择一个文件。
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewPane({
  review,
  reviews,
  onSelect,
  onLocateItem,
}: {
  readonly review: ReviewItem | null;
  readonly reviews: readonly ReviewItem[];
  readonly onSelect: (itemId: string) => void;
  readonly onLocateItem: (itemId: string) => void;
}) {
  if (!review) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-sm">
        当前没有可审阅的确认操作。
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <div className="w-40 shrink-0 overflow-y-auto border-r border-border p-2">
        {reviews.map((item) => (
          <button
            key={item.itemId}
            type="button"
            onClick={() => onSelect(item.itemId)}
            className={cn(
              "w-full rounded-md px-2 py-2 text-left text-sm",
              item.itemId === review.itemId
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <span className="block truncate">{item.title}</span>
            {item.pending && <span className="text-2xs text-warning">等待确认</span>}
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        <h2 className="font-medium text-foreground text-sm">{review.title}</h2>
        {review.summary && <p className="mt-2 text-muted-foreground text-sm">{review.summary}</p>}
        {review.targetPath && (
          <p className="mt-3 font-mono text-muted-foreground text-xs">{review.targetPath}</p>
        )}
        {review.diff ? (
          <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs text-foreground">
            {review.diff}
          </pre>
        ) : (
          <p className="mt-4 text-muted-foreground text-sm">
            此确认未提供差异内容，请回到对话查看操作说明。
          </p>
        )}
        <Button
          className="mt-4"
          variant="outline"
          size="sm"
          onClick={() => onLocateItem(review.itemId)}
        >
          <ChevronLeft />
          回到对话确认
        </Button>
      </div>
    </div>
  );
}
