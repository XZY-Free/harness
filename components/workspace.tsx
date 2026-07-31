"use client";

import { apiFetch } from "@/lib/api-fetch";
import type { ChatMessage, PreviewState, ThreadStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isRunFinished, selectArtifactView } from "@/lib/workspace/artifact-select";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "./chat-panel";
import { Icon } from "./icons";
import { Sidebar } from "./sidebar";
import { ToastProvider } from "./toast";
import type { WorkspacePanelView } from "./workspace-panel/types";
import { WorkbenchPanel } from "./workspace-panel/workbench-panel";
import { isNewThreadShortcut } from "./workspace-shortcuts";

/** 前端 skill 选择器用到的最小信息 */
interface SkillOption {
  id: string;
  name: string;
  description: string;
  category: string | null;
}

/**
 * B-1a: 单个会话的视图状态。Workspace 维护多个会话，切换时只切 active，
 * 不卸载非 active 的 ChatPanel —— 这样 useChat 内部的流式连接不被 abort。
 */
interface ThreadSession {
  id: string;
  messages: ChatMessage[]; // ChatPanel 的 initialMessages（首次挂载后 useChat 接管）
  status: ThreadStatus;
  model: string; // 该会话持久化的模型
  preview: PreviewState;
  /**
   * V5：右侧工作区当前打开的对象。null 表示面板关闭；
   * V9 阶段 5：项目运行页统一改用 `{ kind: "app" }`（在内置浏览器打开）。
   * Phase B+ 会扩展 file / artifact / progress。
   */
  activeWorkspaceView: WorkspacePanelView | null;
  /** V9 阶段 4：右侧三页签工作台是否展开（与 activeWorkspaceView 解耦，浏览器/运行日志无需文件即可访问）。 */
  workbenchOpen: boolean;
  /** 面板关闭后保留最近一次产物对象，顶部入口可重新打开文件/预览。 */
  lastWorkspaceView: WorkspacePanelView | null;
  reloadKey: number;
  selectedSkillId: string | null;
  title?: string; // 会话标题（侧栏同步用）
  /** A-2: ChatPanel 上抛的错误（网络断/重连失败/自检失败），顶栏失败横幅用 */
  error?: string | null;
  /** E-7: 用量统计（消息数/工具调用 part 数/耗时），header 右侧展示 */
  stats?: { messages: number; toolCalls: number; elapsedSec: number | null; running: boolean };
  /** E-7: token 用量（服务端累加真相，run 完成后刷新），header 右侧展示 */
  tokenStats?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** V7 S3-2: 活跃 ThreadRun 信息（从 messages 接口获取），供 ChatPanel 判断是否自动订阅 */
  activeRun?: {
    id: string;
    status: string;
    startedAt: string | null;
    lastSeenAt: string | null;
    canSubscribe: boolean;
  } | null;
}

type SessionStats = NonNullable<ThreadSession["stats"]>;

const MIN_PREVIEW_WIDTH = 320;
const MIN_CHAT_WIDTH = 420;
const DESKTOP_BREAKPOINT = 1024;

/** 宽屏并排时给聊天区保留可用下限，其余空间都允许工作区面板占用。 */
export function maxWorkspacePanelWidth(viewportWidth: number, sidebarWidth: number): number {
  if (viewportWidth < DESKTOP_BREAKPOINT) return Math.max(MIN_PREVIEW_WIDTH, viewportWidth);
  return Math.max(MIN_PREVIEW_WIDTH, viewportWidth - sidebarWidth - MIN_CHAT_WIDTH);
}

export function clampWorkspacePanelWidth(
  width: number,
  viewportWidth: number,
  sidebarWidth: number,
): number {
  return Math.max(
    MIN_PREVIEW_WIDTH,
    Math.min(maxWorkspacePanelWidth(viewportWidth, sidebarWidth), width),
  );
}

function areSessionStatsEqual(a: SessionStats | undefined, b: SessionStats): boolean {
  return (
    !!a &&
    a.messages === b.messages &&
    a.toolCalls === b.toolCalls &&
    a.elapsedSec === b.elapsedSec &&
    a.running === b.running
  );
}

export function Workspace({
  threadId: initialThreadId,
  initialMessages,
  initialStatus,
  initialModel,
  initialPreviewUrl,
  initialTitle,
  platform = "web",
  userId,
}: {
  threadId: string;
  initialMessages: ChatMessage[];
  initialStatus: ThreadStatus;
  initialModel?: string;
  initialPreviewUrl?: string;
  initialTitle?: string;
  platform?: "web" | "desktop";
  userId?: string;
}) {
  const initialPreviewReady = initialStatus === "ready_for_review" && !!initialPreviewUrl;
  const initialModelId = initialModel ?? "";

  // B-1a: 多会话状态。初始会话直接放入 sessions。
  const [sessions, setSessions] = useState<Record<string, ThreadSession>>(() => ({
    [initialThreadId]: {
      id: initialThreadId,
      messages: initialMessages,
      status: initialStatus,
      model: initialModelId,
      title: initialTitle,
      preview: initialPreviewReady
        ? { status: "ready", url: initialPreviewUrl }
        : { status: "idle" },
      activeWorkspaceView: initialPreviewReady && initialPreviewUrl ? { kind: "app" } : null,
      workbenchOpen: initialPreviewReady,
      lastWorkspaceView: initialPreviewReady && initialPreviewUrl ? { kind: "app" } : null,
      reloadKey: 0,
      selectedSkillId: null,
    },
  }));
  // 已打开的会话 id 顺序（渲染用，保证 DOM 稳定）
  const [openOrder, setOpenOrder] = useState<string[]>([initialThreadId]);
  const [activeThreadId, setActiveThreadId] = useState(initialThreadId);
  // A-5: 会话加载失败提示（messages 接口失败时不静默，顶栏横幅提示）
  const [loadError, setLoadError] = useState<string | null>(null);
  const router = useRouter();

  // B-7: activeThreadId 变化时同步 URL（replace 不产生多余历史条目）。
  // 用原生 history.replaceState 绕过 Next.js 客户端导航，避免触发 RSC payload fetch。
  useEffect(() => {
    const currentPath = window.location.pathname;
    const expectedPath = `${platform === "desktop" ? "/desktop" : ""}/chat/${activeThreadId}`;
    if (currentPath !== expectedPath) {
      window.history.replaceState(null, "", expectedPath);
    }
  }, [activeThreadId, platform]);

  // 客户端挂载标记：skill 选择器仅客户端渲染
  const [mounted, setMounted] = useState(false);
  const [models, setModels] = useState<{ id: string; name?: string }[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillOpen, setSkillOpen] = useState(false);
  // E-4: 移动端 sidebar 抽屉开关（< lg 屏幕时 sidebar 为 fixed 抽屉）
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // E-4: sidebar / preview 宽度可拖拽调节，持久化到 localStorage
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [previewWidth, setPreviewWidth] = useState(560);
  const sidebarWidthRef = useRef(sidebarWidth);
  const previewWidthRef = useRef(previewWidth);
  const dragRef = useRef<{
    target: "sidebar" | "preview";
    startX: number;
    startWidth: number;
  } | null>(null);
  sidebarWidthRef.current = sidebarWidth;
  previewWidthRef.current = previewWidth;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sw = Number.parseInt(localStorage.getItem("snowharness:sidebar-width") || "", 10);
    const pw = Number.parseInt(localStorage.getItem("snowharness:preview-width") || "", 10);
    const resolvedSidebarWidth = Number.isNaN(sw)
      ? sidebarWidthRef.current
      : Math.max(200, Math.min(400, sw));
    if (!Number.isNaN(sw)) {
      setSidebarWidth(resolvedSidebarWidth);
      sidebarWidthRef.current = resolvedSidebarWidth;
    }
    if (!Number.isNaN(pw)) {
      const v = clampWorkspacePanelWidth(pw, window.innerWidth, resolvedSidebarWidth);
      setPreviewWidth(v);
      previewWidthRef.current = v;
    }
  }, []);

  // 浏览器缩放或侧栏变宽时，只在超出可用空间后收缩；窗口重新变宽不强制放大。
  useEffect(() => {
    function clampToViewport() {
      const next = clampWorkspacePanelWidth(
        previewWidthRef.current,
        window.innerWidth,
        sidebarWidth,
      );
      if (next !== previewWidthRef.current) {
        setPreviewWidth(next);
        previewWidthRef.current = next;
      }
    }
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [sidebarWidth]);

  const startResize = useCallback((target: "sidebar" | "preview", e: React.MouseEvent) => {
    e.preventDefault();
    const startWidth = target === "sidebar" ? sidebarWidthRef.current : previewWidthRef.current;
    dragRef.current = { target, startX: e.clientX, startWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // E-4: 拖拽 preview 边框时，禁用内部 iframe 的 pointer-events。
    // 否则鼠标快速移入 iframe 后会丢失 mousemove/mouseup（iframe 是独立 document），
    // 导致mouseup未触发、dragRef残留，出现「不点击也能拖动」或「疯狂拖没反应」的怪象。
    if (target === "preview") {
      const section = (e.target as HTMLElement).closest("section");
      if (section) {
        for (const iframe of section.querySelectorAll("iframe")) {
          const el = iframe as HTMLElement;
          el.dataset.prevPointerEvents = el.style.pointerEvents;
          el.style.pointerEvents = "none";
        }
      }
    }
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const { target, startX, startWidth } = dragRef.current;
      const delta = target === "sidebar" ? e.clientX - startX : startX - e.clientX;
      const previewMax = maxWorkspacePanelWidth(window.innerWidth, sidebarWidthRef.current);
      const next = Math.max(
        target === "sidebar" ? 200 : 320,
        Math.min(target === "sidebar" ? 400 : previewMax, startWidth + delta),
      );
      if (target === "sidebar") {
        setSidebarWidth(next);
        sidebarWidthRef.current = next;
      } else {
        setPreviewWidth(next);
        previewWidthRef.current = next;
      }
    }
    function endDrag() {
      if (!dragRef.current) return;
      const { target } = dragRef.current;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // E-4: 恢复 preview 内部 iframe 的 pointer-events
      if (target === "preview") {
        for (const iframe of document.querySelectorAll(
          "section iframe[data-prev-pointer-events]",
        )) {
          const el = iframe as HTMLElement;
          el.style.pointerEvents = el.dataset.prevPointerEvents || "";
          delete el.dataset.prevPointerEvents;
        }
      }
      if (target === "sidebar") {
        localStorage.setItem("snowharness:sidebar-width", String(sidebarWidthRef.current));
      } else {
        localStorage.setItem("snowharness:preview-width", String(previewWidthRef.current));
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", endDrag);
    // E-4: 鼠标移出窗口或窗口失焦时强制结束拖拽，避免 iframe/浏览器外释放鼠标导致 dragRef 残留，
    // 出现「不点击也能拖动」的现象。
    window.addEventListener("mouseleave", endDrag);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", endDrag);
      window.removeEventListener("mouseleave", endDrag);
      window.removeEventListener("blur", endDrag);
    };
  }, []);

  const activeSession = sessions[activeThreadId];

  const validateDraftThread = useCallback(async (threadId: string): Promise<boolean> => {
    const res = await apiFetch(`/api/threads/${threadId}/messages`, { cache: "no-store" });
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw new Error("draft validation failed");
  }, []);

  // C-6: 新建会话——立即落库，保证侧栏可见、刷新不丢，并与 /api/threads POST 语义一致。
  // 若当前会话已是未发送草稿 → 留在原处；
  // 若已有其他草稿 session → 切回去（保留输入框的文字和附件）；
  // 都不满足才创建新 thread。
  const handleNewThread = useCallback(async () => {
    setLoadError(null);
    const model = activeSession?.model ?? initialModelId;
    const getDraftText = (threadId: string) =>
      typeof window === "undefined"
        ? ""
        : (sessionStorage.getItem(`snowharness:draft:${threadId}`) ?? "");
    const restoreDraftInput = (threadId: string) => {
      const text = getDraftText(threadId);
      if (!text) return;
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("snowharness:restore-draft", {
            detail: { threadId, text },
          }),
        );
      }, 0);
    };
    const isDraftSession = (threadId: string) => {
      const session = sessions[threadId];
      return !!session && session.messages.length === 0 && session.status === "idle";
    };

    const createThread = async (replaceDraftId?: string) => {
      const draftText =
        replaceDraftId && typeof window !== "undefined" ? getDraftText(replaceDraftId) : null;
      const res = await apiFetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新会话", model: model || null }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { id?: string; title?: string; status?: ThreadStatus };
      } | null;
      const newId = json?.data?.id;
      if (!res.ok || !json?.ok || !newId) {
        throw new Error("create thread failed");
      }
      if (draftText) {
        sessionStorage.setItem(`snowharness:draft:${newId}`, draftText);
        sessionStorage.removeItem(`snowharness:draft:${replaceDraftId}`);
      }
      setSessions((prev) => ({
        ...Object.fromEntries(Object.entries(prev).filter(([id]) => id !== replaceDraftId)),
        [newId]: {
          id: newId,
          messages: [],
          status: json.data?.status ?? "idle",
          model,
          title: json.data?.title ?? "新会话",
          preview: { status: "idle" },
          activeWorkspaceView: null,
          workbenchOpen: false,
          lastWorkspaceView: null,
          reloadKey: 0,
          selectedSkillId: null,
        },
      }));
      setOpenOrder((prev) => [...prev.filter((id) => id !== replaceDraftId), newId]);
      setActiveThreadId(newId);
      restoreDraftInput(newId);
    };

    try {
      const currentIsDraft = isDraftSession(activeThreadId);
      const currentHasDraftText = getDraftText(activeThreadId).trim().length > 0;
      const otherDraftIds = openOrder.filter((id) => id !== activeThreadId && isDraftSession(id));
      const preferredOtherDraftId =
        otherDraftIds.find((id) => getDraftText(id).trim().length > 0) ?? otherDraftIds[0];

      // 1. 当前草稿已经有输入 → 留在当前草稿；若后端失效则创建新 thread 并迁移文本
      if (currentIsDraft && currentHasDraftText) {
        if (await validateDraftThread(activeThreadId)) return;
        await createThread(activeThreadId);
        return;
      }

      // 2. 优先切回已有输入内容的草稿；没有输入内容时，复用任意已打开草稿
      if (preferredOtherDraftId) {
        if (await validateDraftThread(preferredOtherDraftId)) {
          setActiveThreadId(preferredOtherDraftId);
          restoreDraftInput(preferredOtherDraftId);
          return;
        }
        await createThread(preferredOtherDraftId);
        return;
      }

      // 3. 当前是空草稿且没有其他草稿 → 留在当前；若后端失效则替换
      if (currentIsDraft) {
        if (await validateDraftThread(activeThreadId)) return;
        await createThread(activeThreadId);
        return;
      }

      // 4. 没有草稿 → 后端创建并落库
      await createThread();
    } catch {
      setLoadError("新建会话失败，请重试");
    }
  }, [activeSession, activeThreadId, initialModelId, openOrder, sessions, validateDraftThread]);

  // V5-D1: run 结束后自动选择最适合员工验收的工作区产物。
  // 调 list API 拿文件 → selectArtifactView 推导 view → 仅当员工未主动选过时写入。
  // 不覆盖员工选择（C1 onOpenWorkspace 写入的 view 优先）；previewUrl 优先于文件类产物。
  // V5-D2：handleSelectThread 首次加载旧会话时也调本函数恢复右侧视图。
  const applyArtifactSelection = useCallback((threadId: string, previewUrl?: string) => {
    apiFetch(`/api/threads/${threadId}/workspace`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { ok?: boolean; data?: { files: string[] } } | null) => {
        if (!json?.ok || !Array.isArray(json.data?.files)) return;
        const view = selectArtifactView({
          files: json.data.files,
          previewUrl,
          threadId,
        });
        if (!view) return;
        // 仅当当前 activeWorkspaceView 为空时写入——员工已主动选过则保留。
        setSessions((prev) => {
          const s = prev[threadId];
          if (!s || s.activeWorkspaceView) return prev;
          return {
            ...prev,
            [threadId]: { ...s, activeWorkspaceView: view, lastWorkspaceView: view },
          };
        });
        // 选中产物后确保工作台展开
        setSessions((prev) =>
          prev[threadId] && !prev[threadId].workbenchOpen
            ? { ...prev, [threadId]: { ...prev[threadId], workbenchOpen: true } }
            : prev,
        );
      })
      .catch(() => {});
  }, []);

  // 切换到已有会话：
  // - 已打开过 → 直接切 active（不卸载任何 ChatPanel，流式不中断）
  // - 未打开过 → 先 fetch 历史消息，创建 session，再切 active
  const handleSelectThread = useCallback(
    async (selectedId: string, status: ThreadStatus) => {
      if (selectedId === activeThreadId) return;
      // 已打开：直接切
      if (sessions[selectedId]) {
        // 用传入的最新 status 校正（侧栏拉到的可能比 session 内的更新）
        setSessions((prev) =>
          prev[selectedId] ? { ...prev, [selectedId]: { ...prev[selectedId], status } } : prev,
        );
        setLoadError(null);
        setActiveThreadId(selectedId);
        return;
      }
      // 未打开：加载历史消息后创建 session
      try {
        const res = await apiFetch(`/api/threads/${selectedId}/messages`);
        const json = await res.json();
        if (json.ok && Array.isArray(json.data)) {
          setLoadError(null);
          // C-10: 用接口返回的 thread.model 恢复模型选择器，避免串模型
          const threadModel =
            typeof json.model === "string" && json.model ? json.model : initialModelId;
          // A-5: 用接口返回的真实 status / previewUrl 恢复预览入口，
          // 而非依赖侧栏传入的 status（侧栏可能未刷新到最新）或写死 idle。
          const threadStatus: ThreadStatus =
            (typeof json.status === "string" && json.status) || status;
          const previewUrl: string | undefined =
            typeof json.previewUrl === "string" && json.previewUrl ? json.previewUrl : undefined;
          const previewReady = threadStatus === "ready_for_review" && !!previewUrl;
          // E-7: 从 messages 响应读取 token 用量（run 完成后由 /stats 端点刷新）
          const tokenStats = {
            promptTokens:
              typeof json.tokenStats?.promptTokens === "number" ? json.tokenStats.promptTokens : 0,
            completionTokens:
              typeof json.tokenStats?.completionTokens === "number"
                ? json.tokenStats.completionTokens
                : 0,
            totalTokens:
              typeof json.tokenStats?.totalTokens === "number" ? json.tokenStats.totalTokens : 0,
          };
          // V7 S3-2：从 messages 响应提取活跃 ThreadRun，供 ChatPanel 挂载时判断是否自动订阅 SSE
          const activeRun =
            json.activeRun && typeof json.activeRun === "object"
              ? {
                  id: String(json.activeRun.id ?? ""),
                  status: String(json.activeRun.status ?? ""),
                  startedAt: json.activeRun.startedAt ?? null,
                  lastSeenAt: json.activeRun.lastSeenAt ?? null,
                  canSubscribe: Boolean(json.activeRun.canSubscribe),
                }
              : null;
          setSessions((prev) => ({
            ...prev,
            [selectedId]: {
              id: selectedId,
              messages: json.data,
              status: threadStatus,
              model: threadModel,
              preview: previewReady ? { status: "ready", url: previewUrl } : { status: "idle" },
              activeWorkspaceView: previewReady && previewUrl ? { kind: "app" } : null,
              workbenchOpen: previewReady,
              lastWorkspaceView: previewReady && previewUrl ? { kind: "app" } : null,
              reloadKey: 0,
              selectedSkillId: null,
              tokenStats,
              activeRun,
            },
          }));
          setOpenOrder((prev) => [...prev, selectedId]);
          setActiveThreadId(selectedId);
          // V5-D2：会话视图恢复——首次加载旧会话时若未自动 preview，
          // 调 applyArtifactSelection 按 D1 规则自动选最适合员工验收的产物（README/md/html/pdf/文件列表）。
          // 已在 sessions 中的会话切换不进此分支，sessions[selectedId].activeWorkspaceView 自然保留。
          if (!previewReady) {
            applyArtifactSelection(selectedId, previewUrl);
          }
        }
      } catch {
        // A-5: 加载失败不静默——顶栏提示用户 + 停在当前会话（不切到空白）
        setLoadError("会话加载失败，请重试");
      }
    },
    [activeThreadId, sessions, initialModelId, applyArtifactSelection],
  );

  // D-7: 全局键盘快捷键。
  //  - Cmd/Ctrl+N 新建会话
  //  - Cmd/Ctrl+K 聚焦侧栏搜索框（移动端同时打开抽屉让搜索框可见）
  //  - Cmd/Ctrl+/ 切换快捷键速查面板
  //  - j / k 在可见会话列表内上下切换（非可编辑元素聚焦时）
  const [showShortcuts, setShowShortcuts] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (isNewThreadShortcut(e)) {
        e.preventDefault();
        handleNewThread();
        return;
      }
      if (mod && key === "k") {
        e.preventDefault();
        setMobileSidebarOpen(true);
        // 等抽屉渲染后聚焦搜索框（sidebar 监听此事件聚焦）
        setTimeout(() => window.dispatchEvent(new CustomEvent("snowharness:focus-search")), 60);
        return;
      }
      if (mod && e.key === "/") {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      if (!mod && (key === "j" || key === "k")) {
        const el = document.activeElement as HTMLElement | null;
        const tag = el?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea" || el?.isContentEditable) return;
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("snowharness:navigate-thread", { detail: key === "j" ? "next" : "prev" }),
        );
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNewThread]);

  useEffect(() => {
    // C-1: 监听侧栏标题更新事件（标题生成/重命名后同步顶部 h1）
    const handler = (e: Event) => {
      const { threadId: tid, title } = (e as CustomEvent<{ threadId: string; title: string }>)
        .detail;
      if (!tid || !title) return;
      setSessions((prev) => (prev[tid] ? { ...prev, [tid]: { ...prev[tid], title } } : prev));
    };
    window.addEventListener("snowharness:thread-title-updated", handler);
    return () => window.removeEventListener("snowharness:thread-title-updated", handler);
  }, []);

  useEffect(() => {
    setMounted(true);

    apiFetch("/api/models")
      .then((r) => r.json())
      .then((res: { ok: boolean; data?: { models: { id: string }[]; defaultModel?: string } }) => {
        const list = res.data?.models ?? [];
        const def = res.data?.defaultModel ?? "";
        setModels(list);
        // 默认模型回填到没有持久化模型的 session
        if (def && list.some((m) => m.id === def)) {
          setSessions((prev) => {
            const next: Record<string, ThreadSession> = { ...prev };
            for (const id of Object.keys(next)) {
              const session = next[id];
              if (session && !session.model) {
                next[id] = { ...session, model: def };
              }
            }
            return next;
          });
        }
      })
      .catch(() => {});

    apiFetch("/api/skills")
      .then((r) => r.json())
      .then((res: { ok: boolean; data?: SkillOption[] }) => {
        if (res.ok && res.data) {
          setSkills(res.data);
        }
      })
      .catch(() => {});
  }, []);

  // B-1a: 按会话隔离的状态变更回调。ChatPanel 调用时绑定对应 threadId。
  const handleStatusChange = useCallback(
    (threadId: string, status: ThreadStatus, previewUrl?: string) => {
      setSessions((prev) => {
        const s = prev[threadId];
        if (!s) return prev;
        const next: ThreadSession = { ...s, status };
        if (status === "ready_for_review" && previewUrl) {
          next.preview = { status: "ready", url: previewUrl };
          // V9 阶段 5：自检通过自动在内置浏览器打开运行页（替代旧 preview iframe）。
          next.activeWorkspaceView = { kind: "app" };
          next.lastWorkspaceView = next.activeWorkspaceView;
          next.workbenchOpen = true;
          next.reloadKey = s.reloadKey + 1;
        } else {
          next.preview = { status: "idle" };
          // V5-D1：不再强制清空 activeWorkspaceView——
          // 员工可能已通过 C1 卡片入口主动选择了 view（如点 writeFile 看 src/app.js），
          // run 结束后应保留员工选择；下面会异步调 selectArtifactView 兜底自动选（仅当为空时）。
        }
        return { ...prev, [threadId]: next };
      });
      // V5-D1：run 结束（非 streaming）且未走 ready_for_review+previewUrl 自动 preview 路径时，
      // 扫 workspace 文件按规则自动选最适合员工验收的产物（README / md / html / pdf / 文件列表）。
      // 员工已主动选过 view 时不覆盖（applyArtifactSelection 内判空）。
      if (isRunFinished(status) && !(status === "ready_for_review" && previewUrl)) {
        applyArtifactSelection(threadId, previewUrl);
      }
      // E-7: run 进入终态（非执行中）后刷新 token 用量（onFinish 已累加 DB）。
      if (status !== "executing") {
        apiFetch(`/api/threads/${threadId}/stats`)
          .then((r) => r.json())
          .then((json) => {
            if (json.ok && json.tokenStats) {
              setSessions((prev) =>
                prev[threadId]
                  ? { ...prev, [threadId]: { ...prev[threadId], tokenStats: json.tokenStats } }
                  : prev,
              );
            }
          })
          .catch(() => {});
      }
    },
    [applyArtifactSelection],
  );

  // A-2: 接收 ChatPanel 上抛的错误，写入对应会话的 error（顶栏失败横幅用）
  const setSessionError = useCallback((threadId: string, msg: string | null) => {
    setSessions((prev) =>
      prev[threadId] ? { ...prev, [threadId]: { ...prev[threadId], error: msg } } : prev,
    );
  }, []);

  // E-7: 接收 ChatPanel 上抛的用量统计，写入对应会话（header 右侧展示）
  const setSessionStats = useCallback((threadId: string, stats: SessionStats) => {
    setSessions((prev) => {
      const session = prev[threadId];
      if (!session || areSessionStatsEqual(session.stats, stats)) return prev;
      return { ...prev, [threadId]: { ...session, stats } };
    });
  }, []);

  // V5-C1: 接收 ChatPanel 上抛的工作区产物视图，写入对应会话的 activeWorkspaceView。
  // 右侧面板切换为该视图（file / preview）；当前实现直接覆盖，D2 会处理「会话切换恢复上次视图」。
  const handleOpenWorkspace = useCallback((threadId: string, view: WorkspacePanelView) => {
    setSessions((prev) => {
      const session = prev[threadId];
      if (!session) return prev;
      return {
        ...prev,
        [threadId]: {
          ...session,
          activeWorkspaceView: view,
          lastWorkspaceView: view,
          workbenchOpen: true,
          reloadKey: view.kind === "file" ? session.reloadKey + 1 : session.reloadKey,
        },
      };
    });
  }, []);

  // C-10: 模型切换——乐观更新本地 + 即时 PATCH 持久化（原仅更本地，切后不发消息就刷新会丢）。
  // 失败回滚到旧 model + 顶栏提示。在 functional update 内读取旧 model，避免依赖 sessions。
  const handleModelChange = useCallback(
    async (model: string) => {
      let prevModel: string | undefined;
      setSessions((p) => {
        const s = p[activeThreadId];
        if (!s) return p;
        prevModel = s.model;
        return { ...p, [activeThreadId]: { ...s, model } };
      });
      try {
        const res = await apiFetch(`/api/threads/${activeThreadId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
        if (!res.ok) throw new Error("persist failed");
      } catch {
        // 回滚 + 顶栏提示（workspace 在 ToastProvider 外，复用 loadError 横幅）
        if (prevModel !== undefined) {
          const rollbackModel = prevModel;
          setSessions((p) =>
            p[activeThreadId]
              ? { ...p, [activeThreadId]: { ...p[activeThreadId], model: rollbackModel } }
              : p,
          );
        }
        setLoadError("模型切换失败，已恢复");
      }
    },
    [activeThreadId],
  );

  // V8：Skill 切换只更新本地 UI 信号，不再 PUT 到后端写 thread 绑定。
  // 选择随下一条消息提交给 /api/chat 作为 Resolver 输入（uiSelectedSkillIds）。
  const handleSkillChange = useCallback(
    (skillId: string | null) => {
      setSessions((prev) =>
        prev[activeThreadId]
          ? { ...prev, [activeThreadId]: { ...prev[activeThreadId], selectedSkillId: skillId } }
          : prev,
      );
      setSkillOpen(false);
    },
    [activeThreadId],
  );

  const currentSkillName =
    (activeSession?.selectedSkillId &&
      skills.find((s) => s.id === activeSession.selectedSkillId)?.name) ||
    "不指定 Skill";
  const currentSkillDescription =
    skills.find((s) => s.id === activeSession?.selectedSkillId)?.description ?? "";

  // E-4: memoize skill prop，避免每次渲染创建新对象导致 ChatPanel 不必要重渲染，
  // 重渲染会改变 useChat 的 messages 引用，进而触发 stats effect 无限循环。
  const skillProp = useMemo(
    () => ({
      id: activeSession?.selectedSkillId ?? null,
      name: currentSkillName,
      description: currentSkillDescription,
    }),
    [activeSession?.selectedSkillId, currentSkillName, currentSkillDescription],
  );

  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden bg-[var(--bg)]">
        {/* E-4: 移动端遮罩（< lg 时 sidebar 为 fixed 抽屉） */}
        {mobileSidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/30 lg:hidden"
            onClick={() => setMobileSidebarOpen(false)}
            onKeyDown={() => setMobileSidebarOpen(false)}
          />
        )}
        {/* E-4: sidebar 在 < lg 时为 fixed 抽屉，lg+ 时正常 flex 布局 */}
        <div
          className={`group fixed inset-y-0 left-0 z-50 flex transform transition-transform duration-200 lg:static lg:translate-x-0 ${
            mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          style={{ width: sidebarWidth }}
        >
          <Sidebar
            threadId={activeThreadId}
            status={activeSession?.status ?? "idle"}
            onClose={() => setMobileSidebarOpen(false)}
            onNewThread={() => {
              handleNewThread();
              setMobileSidebarOpen(false);
            }}
            onSelectThread={(id, st) => {
              void handleSelectThread(id, st);
              setMobileSidebarOpen(false);
            }}
          />
          {/* E-4 / V5-A2: sidebar 右边缘拖拽调节宽度（仅桌面端）。
              热区 8px（w-2，cursor-col-resize）保留好拖；可见线 1px，
              hover 只让 1px 线变深，不再出现 8px 整条色块。
              外层 div 负责热区与拖拽，内层 hr 提供语义化分隔线（role=separator）。 */}
          <div
            onMouseDown={(e) => startResize("sidebar", e)}
            className="group absolute right-0 top-0 bottom-0 z-50 hidden w-2 cursor-col-resize lg:block"
            aria-label="调整会话列表宽度"
          >
            <hr className="mx-auto h-full w-px border-0 bg-[var(--border)] transition-colors group-hover:bg-[var(--border-strong)]" />
          </div>
        </div>

        <main className="flex min-w-0 flex-1 flex-col">
          <header
            className="flex items-center justify-between border-[var(--border)] border-b bg-[var(--surface)] px-4 py-3.5 lg:px-6"
            suppressHydrationWarning
          >
            <div className="flex items-center gap-3">
              {/* E-4: 移动端汉堡菜单按钮 */}
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(true)}
                className="flex size-9 items-center justify-center rounded-lg text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)] lg:hidden"
                aria-label="打开会话列表"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12h18M3 6h18M3 18h18" />
                </svg>
              </button>
              <div>
                <h1 suppressHydrationWarning className="font-semibold text-[16px] text-[var(--fg)]">
                  {sessions[activeThreadId]?.title ?? "新会话"}
                </h1>
                {activeSession?.status && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        activeSession.status === "executing"
                          ? "bg-[var(--primary)] animate-gentle-pulse"
                          : activeSession.status === "completed"
                            ? "bg-[var(--ok)]"
                            : activeSession.status === "failed"
                              ? "bg-[var(--danger)]"
                              : "bg-[var(--fg-subtle)]",
                      )}
                    />
                    <span className="text-[11px] text-[var(--fg-muted)]">
                      {activeSession.status === "executing"
                        ? "执行中"
                        : activeSession.status === "completed"
                          ? "已完成"
                          : activeSession.status === "failed"
                            ? "失败"
                            : "空闲"}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* E-7: 用量统计移到 header 右侧 — 轻量化，无边框 */}
              {activeSession?.stats && activeSession.stats.messages > 0 && (
                <div className="flex items-center gap-2 text-[12px] text-[var(--fg-muted)]">
                  <span>{activeSession.stats.messages} 消息</span>
                  <span className="text-[var(--border)]">·</span>
                  <span>{activeSession.stats.toolCalls} 工具</span>
                  {activeSession.stats.running && (
                    <>
                      <span className="text-[var(--border)]">·</span>
                      <span className="flex items-center gap-1 text-[var(--primary)]">
                        <span className="size-1.5 rounded-full bg-[var(--primary)] animate-gentle-pulse" />
                        进行中
                      </span>
                    </>
                  )}
                  {/* E-7: token 用量（服务端累加真相，run 完成后刷新） */}
                  {activeSession.tokenStats && activeSession.tokenStats.totalTokens > 0 && (
                    <>
                      <span className="text-[var(--border)]">·</span>
                      <span>{activeSession.tokenStats.totalTokens} tokens</span>
                    </>
                  )}
                </div>
              )}
              {/* V9 阶段 4：工作台开关——始终可访问浏览器/运行日志，不再依赖预览产物 */}
              <button
                type="button"
                data-codex-workbench
                onClick={() =>
                  setSessions((prev) =>
                    prev[activeThreadId]
                      ? {
                          ...prev,
                          [activeThreadId]: {
                            ...prev[activeThreadId],
                            workbenchOpen: !prev[activeThreadId].workbenchOpen,
                          },
                        }
                      : prev,
                  )
                }
                title="工作台"
                aria-label="切换工作台"
                className={`flex items-center gap-2 rounded-lg border bg-[var(--surface)] px-3.5 py-2 text-[13px] font-medium transition ${
                  activeSession?.workbenchOpen
                    ? "border-[var(--primary)]/40 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--fg-muted)] hover:border-[var(--primary)]/40 hover:text-[var(--primary)]"
                }`}
              >
                <Icon.briefcase size={16} />
              </button>
            </div>
          </header>

          {/* A-2: 顶栏失败横幅覆盖三类失败：自检 failed / 网络断或重连失败（ChatPanel 上抛 error）
              / 会话加载失败（loadError）。避免失败状态只在侧栏红点或输入框错误条体现，顶栏无感知。 */}
          {(activeSession?.status === "failed" || activeSession?.error || loadError) && (
            <div className="flex items-center gap-2 border-b border-[var(--danger)]/30 bg-[var(--danger-soft)] px-4 py-2 text-[13px] text-[var(--danger)] lg:px-6">
              <Icon.warn size={14} className="shrink-0" />
              <span>
                {loadError ||
                  activeSession?.error ||
                  "本轮未通过预览就绪检查，请检查对话中的工具输出，或调整需求后重试。"}
                {!loadError && !activeSession?.error && activeSession?.id ? (
                  <a
                    href={`/studio/threads/${activeSession.id}`}
                    className="ml-1 underline hover:text-[var(--danger)]/80"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    查看详情
                  </a>
                ) : null}
              </span>
            </div>
          )}

          {/* B-1a: 所有已打开会话的 ChatPanel 常驻渲染，非 active 用 hidden 隐藏。
            key=threadId 稳定 + 父 div 不卸载 → useChat 流式连接不被 abort → 切换不中断执行。 */}
          <div className="min-h-0 flex-1">
            {openOrder.map((tid) => {
              const s = sessions[tid];
              if (!s) return null;
              const isActive = tid === activeThreadId;
              return (
                <div key={tid} className="h-full" hidden={!isActive}>
                  <ChatPanel
                    threadId={tid}
                    initialMessages={s.messages}
                    models={models}
                    selectedModel={s.model}
                    skill={skillProp}
                    skills={skills}
                    onSkillChange={handleSkillChange}
                    onModelChange={handleModelChange}
                    // E-4: 直接传稳定 callback，避免每次渲染创建新 inline 函数导致 ChatPanel 重渲染。
                    onStatusChange={handleStatusChange}
                    onError={setSessionError}
                    onStatsChange={setSessionStats}
                    onOpenWorkspace={handleOpenWorkspace}
                    activeRun={s.activeRun}
                  />
                </div>
              );
            })}
          </div>
        </main>

        {activeSession?.workbenchOpen && (
          <>
            {/* E-4: 三态预览区——<md 全屏 overlay / md~lg 右侧 overlay 抽屉 / ≥lg 并排 */}
            <section
              className="fixed inset-0 isolate z-50 min-w-0 bg-[var(--bg)] md:inset-y-0 md:left-auto md:right-0 md:w-auto md:max-w-none md:shadow-2xl lg:relative lg:z-auto lg:h-full lg:shrink-0 lg:shadow-none"
              style={{ width: previewWidth }}
            >
              {/* E-4 / V5-A2: 工作区面板左边缘拖拽调节宽度（md+ 抽屉/并排态均可用）。
                  热区 8px；可见线 1px，hover 只让 1px 线变深。
                  外层 div 负责热区与拖拽，内层 hr 提供语义化分隔线（role=separator）。 */}
              <div
                onMouseDown={(e) => startResize("preview", e)}
                className="group absolute left-0 top-0 bottom-0 z-50 hidden w-3 -translate-x-1/2 cursor-col-resize md:block"
                aria-label="调整工作台宽度"
                title="左右拖动调整工作台宽度"
              >
                <hr className="mx-auto h-full w-px border-0 bg-[var(--border)] transition-colors group-hover:w-0.5 group-hover:bg-[var(--primary)]" />
              </div>
              {/* V10 Phase 1：三页签工作台（工作区/预览/运行日志），PreviewSurface 替代 BrowserPanel */}
              <WorkbenchPanel
                platform={platform}
                userId={userId}
                view={activeSession.activeWorkspaceView}
                threadId={activeThreadId}
                previewUrl={activeSession.preview.url ?? null}
                reloadKey={activeSession.reloadKey}
                onClose={() =>
                  setSessions((prev) =>
                    prev[activeThreadId]
                      ? {
                          ...prev,
                          [activeThreadId]: { ...prev[activeThreadId], workbenchOpen: false },
                        }
                      : prev,
                  )
                }
              />
            </section>
          </>
        )}
      </div>

      {/* D-7: 快捷键速查面板（Cmd/Ctrl+/ 切换） */}
      {showShortcuts && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          onClick={() => setShowShortcuts(false)}
          onKeyDown={() => setShowShortcuts(false)}
        >
          <div
            className="w-[420px] max-w-[90vw] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium text-[15px] text-[var(--fg)]">键盘快捷键</h2>
              <button
                type="button"
                onClick={() => setShowShortcuts(false)}
                className="flex size-6 items-center justify-center rounded text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
                aria-label="关闭"
              >
                <Icon.close size={14} />
              </button>
            </div>
            <dl className="space-y-2 text-[13px]">
              {[
                ["⌘ / Ctrl + N", "新建会话"],
                ["⌘ / Ctrl + K", "搜索会话"],
                ["⌘ / Ctrl + /", "打开本速查面板"],
                ["J / K", "切换到下一个 / 上一个会话"],
                ["/", "聚焦输入框"],
                ["Enter", "发送（send 模式）/ 换行（newline 模式）"],
                ["Shift + Enter", "换行（send 模式）"],
                ["⌘ / Ctrl + Enter", "发送（newline 模式，可在侧栏切换）"],
                ["Esc", "取消编辑 / 关闭面板"],
              ].map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <dt className="text-[var(--fg-muted)]">{desc}</dt>
                  <dd>
                    <kbd className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[12px] text-[var(--fg)]">
                      {key}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </ToastProvider>
  );
}
