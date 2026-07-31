"use client";

import { apiFetch } from "@/lib/api-fetch";
import { SseChatTransport } from "@/lib/chat/sse-transport";
import type { ChatMessage, ThreadStatus } from "@/lib/types";
import { cn, generateUUID } from "@/lib/utils";
import { useChat } from "@ai-sdk/react";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// 12-P1-2：单条消息渲染抽离，供虚拟滚动复用
import { MessageRow } from "./chat/message-row";
import { Icon } from "./icons";
import { ModelSelector } from "./model-selector";
import { useToast } from "./toast";
import type { WorkspacePanelView } from "./workspace-panel/types";

/** 待发送的附件（图片或文档） */
type PendingAttachment =
  | {
      kind: "image";
      id: string;
      url: string;
      filename: string;
      mediaType: string;
    }
  | {
      kind: "document";
      id: string;
      filename: string;
      text: string;
      charCount: number;
    };

// S1（12-P1-6）：TOOL_LABELS 迁移到 lib/i18n
import { t, toolLabel } from "@/lib/i18n";
// 12-P1-1：编辑重发流程封装为 hook（替代内联 pendingReplaceRef/pendingSend/useEffect）
import { useEditResend } from "./hooks/use-edit-resend";

type ChatStats = {
  messages: number;
  toolCalls: number;
  elapsedSec: number | null;
  running: boolean;
};

function areChatStatsEqual(a: ChatStats | null, b: ChatStats): boolean {
  return (
    !!a &&
    a.messages === b.messages &&
    a.toolCalls === b.toolCalls &&
    a.elapsedSec === b.elapsedSec &&
    a.running === b.running
  );
}

function toolDisplayName(toolName: string): string {
  return toolLabel(toolName);
}

export function ChatPanel({
  threadId,
  initialMessages,
  models,
  selectedModel,
  skill,
  skills,
  onSkillChange,
  onModelChange,
  onStatusChange,
  onError,
  onStatsChange,
  onOpenWorkspace,
  activeRun,
}: {
  threadId: string;
  initialMessages: ChatMessage[];
  models: { id: string; name?: string }[];
  selectedModel: string;
  /** 当前会话 skill 选择器信息 */
  skill?: {
    id: string | null;
    name: string;
    description?: string;
  };
  skills?: { id: string; name: string; description: string; category: string | null }[];
  onSkillChange?: (id: string | null) => void;
  onModelChange: (id: string) => void;
  /** 状态变化回调，首参为当前会话 threadId，便于父组件用稳定引用 */
  onStatusChange?: (threadId: string, status: ThreadStatus, previewUrl?: string) => void;
  /** A-2: 上抛错误（网络断/重连失败/自检失败）给 workspace，顶栏显示失败横幅 */
  onError?: (threadId: string, msg: string | null) => void;
  /** E-7: 上抛用量统计（消息数/工具调用 part 数/耗时）给 workspace header 展示 */
  onStatsChange?: (
    threadId: string,
    stats: {
      messages: number;
      toolCalls: number;
      elapsedSec: number | null;
      running: boolean;
    },
  ) => void;
  /**
   * V5-C1：点击工具卡片「查看产物」按钮时上抛对应视图。
   * 首参为当前会话 threadId，便于父组件用稳定引用（与 onStatusChange 等保持一致）。
   */
  onOpenWorkspace?: (threadId: string, view: WorkspacePanelView) => void;
  /** V7 S3-2: 活跃 ThreadRun 信息，canSubscribe=true 时自动订阅 SSE */
  activeRun?: {
    id: string;
    status: string;
    startedAt: string | null;
    lastSeenAt: string | null;
    canSubscribe: boolean;
  } | null;
}) {
  const toast = useToast(); // D-10: 替换 alert() 的 toast 系统
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false); // D-5: 拖拽悬停 UI 反馈
  // 附件 hover 预览：鼠标移开后延迟 1s 关闭，允许用户移入弹窗滚动浏览
  const [hoveredAttId, setHoveredAttId] = useState<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterAtt = useCallback((id: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredAttId(id);
  }, []);
  const leaveAtt = useCallback((id: string) => {
    hoverTimerRef.current = setTimeout(() => {
      setHoveredAttId((cur) => (cur === id ? null : cur));
    }, 1000);
  }, []);
  useEffect(
    () => () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    },
    [],
  );
  // D-8: Enter 行为偏好（send=Enter发送 / newline=Enter换行⌘Enter发送）。localStorage 持久化。
  // sidebar 底部切换入口 dispatch snowharness:enter-behavior-change 事件，这里监听响应。
  const [enterBehavior, setEnterBehavior] = useState<"send" | "newline">(() => {
    if (typeof window === "undefined") return "send";
    return localStorage.getItem("snowharness:enter-behavior") === "newline" ? "newline" : "send";
  });
  useEffect(() => {
    const handler = (e: Event) => {
      const mode = (e as CustomEvent<"send" | "newline">).detail;
      if (mode === "send" || mode === "newline") setEnterBehavior(mode);
    };
    window.addEventListener("snowharness:enter-behavior-change", handler);
    return () => window.removeEventListener("snowharness:enter-behavior-change", handler);
  }, []);

  // D-6: 草稿跨会话保留（sessionStorage）。挂载恢复，变化写入，submit 后清除。
  const draftKey = `snowharness:draft:${threadId}`;
  useEffect(() => {
    const saved = sessionStorage.getItem(draftKey);
    if (saved) setInput(saved);
    // 仅挂载时恢复一次（threadId 变化时也会重读，但 ChatPanel 按 threadId 常驻不切）
  }, [draftKey]);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId?: string; text?: string }>).detail;
      if (detail?.threadId !== threadId) return;
      const text = detail.text ?? sessionStorage.getItem(draftKey) ?? "";
      setInput(text);
      sessionStorage.setItem(draftKey, text);
    };
    window.addEventListener("snowharness:restore-draft", handler);
    return () => window.removeEventListener("snowharness:restore-draft", handler);
  }, [draftKey, threadId]);
  useEffect(() => {
    sessionStorage.setItem(draftKey, input);
  }, [draftKey, input]);
  /** 正在编辑的消息 ID（user 消息） */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 编辑中的文本内容 */
  const [editText, setEditText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 12-P1-1：被替换的旧消息 id — transport 闭包读取后传后端删除（hook 接管生命周期）
  const replaceFromRef = useRef<string | null>(null);
  // 错误反馈：agent 执行失败（onFinish status:failed）或 onError 回调写入
  const [lastError, setLastError] = useState<string | null>(null);
  // A-2: 上抛 lastError 给 workspace（顶栏失败横幅）。ref 避免 onError 不稳定导致 effect 循环。
  const onErrorPropRef = useRef(onError);
  onErrorPropRef.current = onError;
  useEffect(() => {
    onErrorPropRef.current?.(threadId, lastError);
  }, [lastError, threadId]);

  // E-4: ref 持有 workspace 回调，transport/useChat 选项可保持引用稳定，避免重渲染导致循环。
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  // V5-C1: 同样用 ref 持有 onOpenWorkspace，绑定时再注入 threadId 透传给 MessageRow。
  // 用 ref + useCallback 让透传函数引用稳定，避免每次渲染都让 MessageRow 重渲染。
  const onOpenWorkspaceRef = useRef(onOpenWorkspace);
  onOpenWorkspaceRef.current = onOpenWorkspace;
  const handleOpenWorkspaceFromMessage = useCallback(
    (view: WorkspacePanelView) => {
      onOpenWorkspaceRef.current?.(threadId, view);
    },
    [threadId],
  );
  // 自动滚动：消息容器 ref + 是否吸附底部的标志
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // A-3: 「回到底部」浮标显隐（上滚查看历史时出现，吸附底部时隐藏）。ref 不触发重渲染，故另存 state。
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // D-4: textarea 自增高
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // B-4: SSE 非主动断开时的重连状态（reconnecting=重连中，向用户显示提示条）
  const [reconnecting, setReconnecting] = useState(false);
  // skill 下拉浮层开关（从 header 下移到输入框工具栏）
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  // V6-M2-1: 跨标签 run 状态同步——其他标签有活跃 run 时阻止本标签并发提交
  const [crossTabBusy, setCrossTabBusy] = useState(false);
  // selectedModel 的 ref 镜像：让 transport 的 prepareSendMessagesRequest 闭包始终读到最新值，
  // 从而 transport 实例可 useMemo 稳定（不随 selectedModel 变化重建，保留 lastRunId 供重连）。
  const selectedModelRef = useRef(selectedModel);
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);
  // V8：skillId ref 镜像——让 transport 的 prepareSendMessagesRequest 闭包读到最新 skill 选择，
  // transport 实例可 useMemo 稳定（不随 skill 变化重建，保留 lastRunId 供重连）。
  const skillIdRef = useRef(skill?.id ?? null);
  useEffect(() => {
    skillIdRef.current = skill?.id ?? null;
  }, [skill?.id]);

  // E-7: 执行耗时统计 —— submitted/streaming 起记，回到终态（ready/error）结算，展示「· Xs」。
  const runStartRef = useRef<number | null>(null);
  const [lastElapsedSec, setLastElapsedSec] = useState<number | null>(null);

  /** D-4: textarea 按内容自增高，上限由 max-h-44 控制后转内部滚动。 */
  const autoResizeTextarea = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setInput(next);
      sessionStorage.setItem(draftKey, next);
      autoResizeTextarea(e.target);
    },
    [autoResizeTextarea, draftKey],
  );

  // D-4: input 变化时同步增高（粘贴/外部 setInput 也触发）
  // biome-ignore lint/correctness/useExhaustiveDependencies: input 是高度重算的触发信号
  useEffect(() => {
    if (inputRef.current) autoResizeTextarea(inputRef.current);
  }, [input, autoResizeTextarea]);

  // B-4: transport 实例需在渲染间稳定，否则 lastRunId 丢失导致重连失效。
  // 通过 ref 读取最新回调，deps 保持为空，避免父组件 inline 回调导致反复重建。
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadId 由 key 保证稳定，回调通过 ref 读取
  const transport = useMemo(
    () =>
      new SseChatTransport({
        api: "/api/chat",
        onReconnectStateChange: (state) => {
          setReconnecting(state === "reconnecting");
          if (state === "failed") {
            setLastError(t("chat.connection.failed"));
            onStatusChangeRef.current?.(threadId, "idle");
          }
        },
        prepareSendMessagesRequest({ messages: msgs, id }) {
          // 编辑重新生成时，把被替换的旧消息 id 传给后端，后端负责删除旧消息
          // V6-M3-6：不再立即清空 replaceFromRef，改由 onSendSuccess 回调在 POST 成功后清空
          const replaceFrom = replaceFromRef.current;
          const body: Record<string, unknown> = {
            id,
            message: msgs.at(-1),
            model: selectedModelRef.current,
          };
          if (replaceFrom) body.replaceFrom = replaceFrom;
          // V8：UI Skill 选择随消息提交，作为本轮 Resolver 输入信号（不写 thread 绑定）
          const skillId = skillIdRef.current;
          body.uiSelectedSkillIds = skillId ? [skillId] : [];
          return { body };
        },
        onSendSuccess: () => {
          // V6-M3-6：POST 成功后清空 replaceFromRef，避免失败重试时仍携带旧值
          replaceFromRef.current = null;
        },
      }),
    [],
  );

  // E-4: useChat 的 onError/onFinish 回调用 useCallback + ref 保持引用稳定，
  // 避免父组件每次渲染传新 inline 函数导致 useChat 重新初始化 → messages 引用变化 → stats effect 循环。
  const handleChatError = useCallback(
    (err: Error) => {
      setLastError(err.message || t("chat.error.default"));
      // A-6: 乐观状态回滚 —— submit 时乐观设了 "executing"，请求失败必须回滚到 idle，
      // 否则 UI 会同时显示「执行中」跳动点和错误条，矛盾态。
      onStatusChangeRef.current?.(threadId, "idle");
    },
    [threadId],
  );

  const handleChatFinish = useCallback(
    ({ message }: { message: ChatMessage }) => {
      const artifactPart = message.parts.find(
        (p: { type: string }) => p.type === "data-artifact",
      ) as
        | { type: "data-artifact"; data: { previewUrl: string; status: ThreadStatus } }
        | undefined;
      if (artifactPart) {
        onStatusChangeRef.current?.(
          threadId,
          artifactPart.data.status,
          artifactPart.data.previewUrl,
        );
        // 自检失败 → 给用户明确错误反馈；成功 → 清空
        setLastError(
          artifactPart.data.status === "failed" ? t("chat.error.generate_failed") : null,
        );
        // C-1 重构后：自动标题生成改由 chat route 首条消息时并行触发（generateThreadTitle），
        // 前端不再在 onFinish 触发 generate-title。标题更新经 SSE/列表刷新到达侧栏。
      } else {
        setLastError(null);
      }
    },
    [threadId],
  );

  const { messages, sendMessage, status, setMessages, stop, regenerate, error, resumeStream } =
    useChat<ChatMessage>({
      id: threadId,
      messages: initialMessages,
      generateId: generateUUID,
      transport,
      onError: handleChatError,
      onFinish: handleChatFinish,
    });

  // V7 S3-2：首次挂载时，若有可订阅的活跃 run，自动恢复 SSE 订阅。
  // transport.setTargetRun 写入 runId → useChat.resumeStream() → transport.reconnectToStream()
  // 命中 lastChatId/lastRunId → 建立韧性 SSE 流。仅挂载时执行一次。
  const resumedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时执行一次
  useEffect(() => {
    if (resumedRef.current) return;
    if (!activeRun?.canSubscribe || !activeRun.id) return;
    resumedRef.current = true;
    transport.setTargetRun(threadId, activeRun.id);
    onStatusChangeRef.current?.(threadId, "executing");
    resumeStream().catch(() => {
      // resume 失败回滚状态（handleChatError 也会处理，此处兜底）
      onStatusChangeRef.current?.(threadId, "idle");
    });
  }, []);

  // 12-P1-1：编辑重发流程封装为 hook（替代原内联 pendingReplaceRef/pendingSend/useEffect）
  // replaceFromRef 先于 transport 创建，hook 复用同一 ref，transport 闭包读取后传后端删旧消息
  const { startEditResend } = useEditResend({
    setMessages,
    sendMessage,
    onSend: () => onStatusChangeRef.current?.(threadId, "executing"),
    replaceFromRef,
  });

  // 网络层错误（fetch 失败）由 useChat.error 捕获，与 agent 执行失败合并展示
  const displayError = error ? error.message || t("chat.error.default") : lastError;

  // E-7: 用量统计上抛 workspace header（消息数 + 工具调用 part 数 + 执行耗时）。
  // 工具调用按 part 数计（type 以 tool- 开头或 dynamic-tool），一次调用一个 part；
  // 原按「含 tool part 的消息数」计，一条消息多个 tool call 只算 1，严重低估。
  const onStatsChangeRef = useRef(onStatsChange);
  onStatsChangeRef.current = onStatsChange;
  const stats: ChatStats = useMemo(() => {
    const toolCalls = messages
      .flatMap((m) => m.parts ?? [])
      .filter(
        (p) =>
          typeof p.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool"),
      ).length;
    return {
      messages: messages.length,
      toolCalls,
      elapsedSec: lastElapsedSec,
      running: status === "submitted" || status === "streaming",
    };
  }, [messages, lastElapsedSec, status]);
  const lastReportedStatsRef = useRef<{ threadId: string; stats: ChatStats } | null>(null);
  useEffect(() => {
    if (
      lastReportedStatsRef.current?.threadId === threadId &&
      areChatStatsEqual(lastReportedStatsRef.current.stats, stats)
    ) {
      return;
    }
    lastReportedStatsRef.current = { threadId, stats };
    onStatsChangeRef.current?.(threadId, stats);
  }, [stats, threadId]);

  // E-7: 执行耗时统计 —— submitted/streaming 起记，回到终态（ready/error）结算。
  useEffect(() => {
    const busy = status === "submitted" || status === "streaming";
    if (busy) {
      if (runStartRef.current === null) runStartRef.current = Date.now();
    } else if (runStartRef.current !== null) {
      const elapsed = Math.round((Date.now() - runStartRef.current) / 1000);
      runStartRef.current = null;
      setLastElapsedSec(elapsed);
    }
  }, [status]);

  // 流式自动滚动：用户在底部时跟随，上滚查看历史时不强制拉回
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = stick;
    // A-3: 上滚时显示「回到底部」浮标；函数式更新避免值相同时多余渲染
    setShowScrollToBottom((prev) => (prev === !stick ? prev : !stick));
  }, []);

  // A-3: 点击「回到底部」浮标 → 滚到底 + 恢复吸附 + 隐藏浮标
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
  }, []);

  const busy = status === "submitted" || status === "streaming";
  const empty = messages.length === 0;
  const hasContent = input.trim().length > 0 || attachments.length > 0;

  const initialScrollForThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialScrollForThreadRef.current === threadId) return;
    if (messages.length === 0) {
      initialScrollForThreadRef.current = threadId;
      return;
    }
    initialScrollForThreadRef.current = threadId;
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [threadId, messages.length]);
  // 预览打开会压缩主栏宽度，动态高度消息 + 虚拟滚动在 React 19 下会反复测量并触发循环更新。
  // 这里改回普通列表滚动，保留到底部吸附即可。
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages/status 驱动新内容与流式状态后的吸底滚动
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  // V6-M2-1: BroadcastChannel 跨标签同步（G2/A2）
  // 当本标签 run 状态变化时广播，其他标签收到后更新提示。
  useEffect(() => {
    if (!threadId) return;
    const channel = new BroadcastChannel(`snowharness:thread-${threadId}`);
    channel.postMessage({ type: "run-status", status, threadId });
    return () => channel.close();
  }, [threadId, status]);

  // V6-M2-1: 监听跨标签 run 状态广播
  useEffect(() => {
    if (!threadId) return;
    const channel = new BroadcastChannel(`snowharness:thread-${threadId}`);
    channel.onmessage = (event) => {
      if (event.data?.type === "run-status" && event.data.threadId === threadId) {
        const remoteStatus = event.data.status;
        // 其他标签正在执行时，本标签标记 crossTabBusy 防并发提交
        setCrossTabBusy(remoteStatus === "submitted" || remoteStatus === "streaming");
      }
    };
    return () => channel.close();
  }, [threadId]);

  /** 选择文件后上传/解析 */
  /** D-5: 上传单个文件 → PendingAttachment（失败返回 null 并 toast）。 */
  async function uploadOneFile(file: File): Promise<PendingAttachment | null> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("threadId", threadId);
    try {
      const res = await apiFetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t("chat.upload.failed", { name: file.name }));
        return null;
      }
      if (data.kind === "image") {
        return {
          kind: "image",
          id: generateUUID(),
          url: data.url,
          filename: data.filename,
          mediaType: data.type,
        };
      }
      return {
        kind: "document",
        id: generateUUID(),
        filename: data.filename,
        text: data.text,
        charCount: data.charCount,
      };
    } catch {
      toast.error(t("chat.upload.network_error", { name: file.name }));
      return null;
    }
  }

  /** D-5: 批量处理文件（多选/粘贴/拖拽共用）。限制单次5文件、单文件20MB。 */
  async function handleFiles(files: File[]) {
    const MAX_FILES = 5;
    const MAX_BYTES = 20 * 1024 * 1024;
    if (files.length === 0) return;
    if (files.length > MAX_FILES) {
      toast.error(t("chat.upload.max_files", { n: MAX_FILES }));
      return;
    }
    const tooLarge = files.find((f) => f.size > MAX_BYTES);
    if (tooLarge) {
      toast.error(t("chat.upload.too_large", { name: tooLarge.name }));
      return;
    }

    setUploading(true);
    try {
      const results = await Promise.all(files.map(uploadOneFile));
      const ok = results.filter((r): r is PendingAttachment => r !== null);
      if (ok.length > 0) setAttachments((prev) => [...prev, ...ok]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    await handleFiles(files);
  }

  /** 移除待发附件 */
  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function submit(text?: string) {
    const value = (text ?? input).trim();
    if ((!value && attachments.length === 0) || busy || crossTabBusy) {
      return;
    }

    // 组装 AI SDK v6 合法 parts：文档卡片走 data-*，图片走 file。
    const parts: ChatMessage["parts"] = [];

    for (const att of attachments) {
      if (att.kind === "document") {
        parts.push({
          type: "data-attachment",
          data: {
            filename: att.filename,
            charCount: att.charCount,
            text: att.text,
          },
        });
      }
    }

    // 用户输入文本
    if (value) {
      parts.push({ type: "text", text: value });
    }

    // 最后放图片
    for (const att of attachments) {
      if (att.kind === "image") {
        parts.push({
          type: "file",
          mediaType: att.mediaType,
          filename: att.filename,
          url: att.url,
        });
      }
    }

    setLastError(null);
    sendMessage({ role: "user", parts });
    setInput("");
    sessionStorage.removeItem(draftKey); // D-6: 发送后清草稿
    setAttachments([]);
    onStatusChangeRef.current?.(threadId, "executing");
  }

  /** 复制消息文本到剪贴板 */
  const copyMessage = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback：降级时静默失败
    }
  }, []);

  /** 判断指定 user 消息是否为最后一条 user 消息 */
  const isLastUserMessage = useCallback(
    (msgId: string) => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role === "user") return message.id === msgId;
      }
      return false;
    },
    [messages],
  );

  /** 开始编辑某条 user 消息 */
  const startEdit = useCallback((msgId: string, text: string) => {
    setEditingId(msgId);
    setEditText(text);
  }, []);

  /** 取消编辑 */
  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditText("");
  }, []);

  // D-7: 键盘快捷键。Escape 取消编辑；/ 聚焦输入框（未在可编辑元素时）。
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && editingId) {
        e.preventDefault();
        cancelEdit();
        return;
      }
      if (e.key === "/") {
        const el = document.activeElement as HTMLElement | null;
        const tag = el?.tagName?.toLowerCase();
        // 已在输入框/textarea/contentEditable 时不抢焦点
        if (tag === "input" || tag === "textarea" || el?.isContentEditable) return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingId, cancelEdit]);

  /**
   * 确认编辑。
   *
   * D-9：编辑入口仅对「最后一条 user 消息」显示（见消息渲染层 !isLastUser ? hidden），
   * 故此处只保留原地替换重新生成分支，移除此前「历史消息塞回输入框」的怪异行为与对应死代码。
   *
   * 12-P1-1：流程封装到 useEditResend hook（startEditResend 内部管 replaceFromRef +
   * setMessages + pending effect 触发 sendMessage）。本函数只负责读 editingId/editText
   * 并调 startEditResend，时序绕过逻辑不再内联。
   */
  const confirmEdit = useCallback(() => {
    if (!editingId) return;
    const value = editText.trim();
    if (!value) {
      setEditingId(null);
      setEditText("");
      return;
    }
    // 仅最后一条 user 消息可编辑：截断到该消息之前，重新发送编辑内容（重新生成）
    if (isLastUserMessage(editingId)) {
      const idx = messages.findIndex((m) => m.id === editingId);
      if (idx >= 0) {
        // 编辑动作清旧错误（原内联 useEffect 内的 setLastError(null)）
        setLastError(null);
        // hook 接管：记录 replaceFromId + 截断 messages + 标记 pending（effect 内 sendMessage）
        startEditResend({
          replaceFromId: editingId,
          truncatedMessages: messages.slice(0, idx),
          newText: value,
        });
      }
    }
    setEditingId(null);
    setEditText("");
  }, [editingId, editText, isLastUserMessage, messages, startEditResend]);

  function onFormSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // D-8: send 模式 Enter 发送（Shift+Enter 换行）；newline 模式 Cmd/Ctrl+Enter 发送（Enter 换行）
    const isSubmitKey =
      enterBehavior === "send"
        ? event.key === "Enter" && !event.shiftKey
        : event.key === "Enter" && (event.metaKey || event.ctrlKey);
    if (isSubmitKey) {
      event.preventDefault();
      submit();
    }
  }

  // ─── Empty state: centered composition ──────────────────────
  if (empty) {
    return (
      <div className="flex h-full flex-col">
        {/* 隐藏文件选择器 */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.odt,.odp,.ods,.rtf,.csv,.md,.txt,.html"
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* B-4 / A-2: 错误条（移除重连提示，用户不需要看到技术性状态） */}
        {displayError && (
          <div className="mx-4 mt-4 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-[13px] text-[var(--danger)]">
            <Icon.warn size={14} className="shrink-0" />
            <span className="flex-1">{displayError}</span>
            <button
              type="button"
              onClick={() => {
                setLastError(null);
                regenerate();
              }}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[12px] font-medium text-[var(--danger)] transition hover:bg-[var(--danger)]/10"
              title={t("common.retry")}
            >
              <Icon.refresh size={12} />
              {t("common.retry")}
            </button>
            <button
              type="button"
              onClick={() => setLastError(null)}
              className="flex size-5 items-center justify-center rounded text-[var(--danger)] transition hover:bg-[var(--danger)]/10"
              title={t("studio.nav.close")}
            >
              <Icon.close size={12} />
            </button>
          </div>
        )}

        {/* 居中主区域 */}
        <div className="flex flex-1 flex-col items-center justify-center px-6">
          <div className="animate-rise-enhanced w-full max-w-4xl">
            {/* 图标区域 */}
            <div className="mb-6 flex justify-center">
              <div className="relative">
                <div className="absolute inset-0 blur-3xl bg-[var(--primary)]/20 rounded-full" />
                <div className="relative flex size-20 items-center justify-center rounded-full bg-[var(--accent-soft)]">
                  <Icon.chat size={40} className="text-[var(--primary)]" />
                </div>
              </div>
            </div>

            {/* 标题 */}
            <h2 className="mb-3 text-center text-[36px] font-bold tracking-tight text-[var(--fg)]">
              {t("chat.empty.title")}
            </h2>
            <p className="mb-10 text-center text-[16px] text-[var(--fg-muted)]">
              {t("chat.empty.subtitle")}
            </p>

            {/* 输入框（大圆角 + 柔和阴影） */}
            <form onSubmit={onFormSubmit}>
              <div
                className={`w-full rounded-[24px] border-2 bg-[var(--surface)] transition-all ${
                  dragging
                    ? "border-[var(--primary)] border-dashed bg-[var(--accent-soft)]/30"
                    : "border-[var(--border)] focus-within:border-[var(--primary)]/60 focus-within:shadow-[var(--shadow-accent)]"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  handleFiles(Array.from(e.dataTransfer.files));
                }}
              >
                {/* 待发送附件预览区 */}
                {attachments.length > 0 && (
                  <div className="flex flex-wrap items-start gap-3 border-b border-[var(--border)] px-4 pt-3 pb-2">
                    {attachments.map((att) =>
                      att.kind === "image" ? (
                        <div key={att.id} className="group relative">
                          <div
                            className="h-20 w-20 overflow-hidden rounded-[var(--radius)] border-2 border-[var(--border)] transition-all hover:border-[var(--primary)]/40 hover:shadow-[var(--shadow-sm)]"
                            onMouseEnter={() => enterAtt(att.id)}
                            onMouseLeave={() => leaveAtt(att.id)}
                          >
                            <img
                              src={att.url}
                              alt={att.filename}
                              className="h-full w-full object-cover transition-transform hover:scale-105"
                            />
                          </div>
                          <div
                            className={cn(
                              "absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2",
                              hoveredAttId === att.id ? "block" : "hidden",
                            )}
                            onMouseEnter={() => enterAtt(att.id)}
                            onMouseLeave={() => leaveAtt(att.id)}
                          >
                            <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] shadow-[var(--shadow-lg)]">
                              <img
                                src={att.url}
                                alt={att.filename}
                                className="max-h-[40rem] max-w-3xl object-contain"
                              />
                            </div>
                            <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-[var(--border)] bg-[var(--bg)]" />
                          </div>
                          <button
                            type="button"
                            onClick={() => removeAttachment(att.id)}
                            className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)] text-[var(--fg-muted)] opacity-0 shadow-sm transition group-hover:opacity-100 hover:border-[var(--danger)] hover:text-[var(--danger)]"
                          >
                            <Icon.close size={12} />
                          </button>
                        </div>
                      ) : (
                        <div
                          key={att.id}
                          className="group relative flex h-20 w-40 flex-col justify-center rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 transition-all hover:border-[var(--primary)]/40 hover:shadow-[var(--shadow-sm)]"
                          onMouseEnter={() => enterAtt(att.id)}
                          onMouseLeave={() => leaveAtt(att.id)}
                        >
                          <div className="flex items-center gap-2">
                            <div className="flex size-8 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
                              <Icon.fileText size={16} className="shrink-0 text-[var(--primary)]" />
                            </div>
                            <span className="min-w-0 truncate text-[12px] font-medium text-[var(--fg)]">
                              {att.filename}
                            </span>
                          </div>
                          <span className="ml-10 text-[11px] text-[var(--fg-muted)]">
                            {att.charCount.toLocaleString()} 字符
                          </span>
                          <div
                            className={cn(
                              "absolute bottom-full left-0 z-50 mb-2 w-[56rem] max-w-[90vw]",
                              hoveredAttId === att.id ? "block" : "hidden",
                            )}
                            onMouseEnter={() => enterAtt(att.id)}
                            onMouseLeave={() => leaveAtt(att.id)}
                          >
                            <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] shadow-[var(--shadow-lg)]">
                              <div className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                                <span className="text-[13px] font-medium text-[var(--fg)]">
                                  {att.filename}
                                </span>
                                <span className="ml-2 text-[11px] text-[var(--fg-muted)]">
                                  {att.charCount.toLocaleString()} 字符
                                </span>
                              </div>
                              <div className="max-h-[36rem] overflow-auto p-3">
                                <pre className="whitespace-pre-wrap text-[12px] leading-5 text-[var(--fg-muted)]">
                                  {att.text.slice(0, 2400)}
                                  {att.text.length > 2400 ? "..." : ""}
                                </pre>
                              </div>
                            </div>
                            <div className="absolute -bottom-1 left-6 h-2 w-2 rotate-45 border-b border-r border-[var(--border)] bg-[var(--bg)]" />
                          </div>
                          <button
                            type="button"
                            onClick={() => removeAttachment(att.id)}
                            className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)] text-[var(--fg-muted)] opacity-0 shadow-sm transition group-hover:opacity-100 hover:border-[var(--danger)] hover:text-[var(--danger)]"
                          >
                            <Icon.close size={12} />
                          </button>
                        </div>
                      ),
                    )}
                    {uploading && (
                      <div className="flex h-10 w-20 items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--border)]">
                        <Icon.spinner size={18} className="animate-spin text-[var(--fg-subtle)]" />
                      </div>
                    )}
                  </div>
                )}

                <textarea
                  ref={inputRef}
                  className="w-full resize-none bg-transparent px-5 py-5 text-[16px] leading-7 outline-none placeholder:text-[var(--fg-subtle)]/70 transition-opacity focus:placeholder:opacity-60"
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={onKeyDown}
                  onPaste={(e) => {
                    const imgs = Array.from(e.clipboardData.files).filter((f) =>
                      f.type.startsWith("image/"),
                    );
                    if (imgs.length > 0) {
                      e.preventDefault();
                      handleFiles(imgs);
                    }
                  }}
                  placeholder={
                    enterBehavior === "send"
                      ? t("chat.placeholder.send")
                      : t("chat.placeholder.newline")
                  }
                  rows={2}
                />

                <div className="flex items-center justify-between gap-2 px-3 pb-3">
                  <div className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      title={t("chat.upload.attach")}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className={`flex size-9 shrink-0 items-center justify-center rounded-full transition-all ${
                        uploading
                          ? "cursor-wait text-[var(--fg-muted)] opacity-50"
                          : "text-[var(--fg-subtle)] hover:bg-[var(--surface-2)] hover:text-[var(--primary)] hover:scale-105"
                      }`}
                    >
                      <Icon.plus size={18} />
                    </button>
                    {skill && skills && skills.length > 0 && onSkillChange && (
                      <div className="relative">
                        <button
                          type="button"
                          title={skill.description}
                          onClick={() => setSkillOpen((o) => !o)}
                          className="flex max-w-[160px] items-center gap-2 truncate rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] font-medium text-[var(--fg-muted)] transition hover:border-[var(--primary)]/40 hover:text-[var(--primary)]"
                        >
                          <Icon.sparkles size={14} className="shrink-0 text-[var(--primary)]" />
                          <span className="truncate">{skill.name}</span>
                          <Icon.chevron
                            size={12}
                            className={`shrink-0 transition ${skillOpen ? "rotate-180" : ""}`}
                          />
                        </button>
                        {skillOpen && (
                          <>
                            <div
                              className="fixed inset-0 z-30"
                              onClick={() => setSkillOpen(false)}
                              onKeyDown={() => setSkillOpen(false)}
                            />
                            <div className="absolute bottom-full left-0 z-40 mb-2 w-[400px] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-lg">
                              <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-[var(--fg-muted)]">
                                选择技能
                              </div>
                              <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
                                <Icon.search
                                  size={14}
                                  className="shrink-0 text-[var(--fg-subtle)]"
                                />
                                <input
                                  value={skillQuery}
                                  onChange={(e) => setSkillQuery(e.target.value)}
                                  placeholder="搜索技能…"
                                  className="w-full bg-transparent text-[13px] outline-none placeholder:text-[var(--fg-subtle)]"
                                />
                                {skillQuery && (
                                  <button
                                    type="button"
                                    onClick={() => setSkillQuery("")}
                                    className="text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                                    aria-label="清除搜索"
                                  >
                                    <Icon.close size={12} />
                                  </button>
                                )}
                              </div>
                              <div className="max-h-80 overflow-y-auto p-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    onSkillChange(null);
                                    setSkillOpen(false);
                                    setSkillQuery("");
                                  }}
                                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition hover:bg-[var(--surface-2)] ${skill.id === null ? "text-[var(--primary)]" : "text-[var(--fg)]"}`}
                                >
                                  <Icon.check
                                    size={14}
                                    className={skill.id === null ? "" : "invisible"}
                                  />
                                  不指定 Skill
                                  <span className="ml-auto text-[11px] text-[var(--fg-muted)]">
                                    基础 agent
                                  </span>
                                </button>
                                {skills
                                  .filter(
                                    (s) =>
                                      s.name.toLowerCase().includes(skillQuery.toLowerCase()) ||
                                      s.category?.toLowerCase().includes(skillQuery.toLowerCase()),
                                  )
                                  .map((s) => (
                                    <button
                                      key={s.id}
                                      type="button"
                                      onClick={() => {
                                        onSkillChange(s.id);
                                        setSkillOpen(false);
                                        setSkillQuery("");
                                      }}
                                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition hover:bg-[var(--surface-2)] ${skill.id === s.id ? "text-[var(--primary)]" : "text-[var(--fg)]"}`}
                                    >
                                      <Icon.check
                                        size={14}
                                        className={skill.id === s.id ? "" : "invisible"}
                                      />
                                      <span className="truncate">{s.name}</span>
                                      {s.category && (
                                        <span className="ml-auto shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)]">
                                          {s.category}
                                        </span>
                                      )}
                                    </button>
                                  ))}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2.5">
                    <ModelSelector
                      models={models}
                      value={selectedModel}
                      onChange={onModelChange}
                      direction="up"
                      compact
                    />
                    {busy ? (
                      <button
                        type="button"
                        onClick={() => {
                          stop();
                          apiFetch(`/api/threads/${threadId}/cancel`, { method: "POST" }).catch(
                            () => {},
                          );
                          onStatusChangeRef.current?.(threadId, "idle");
                        }}
                        title={t("chat.stop")}
                        className="flex size-9 items-center justify-center rounded-full bg-[var(--danger)] text-white shadow-[var(--shadow-sm)] transition-all hover:bg-[var(--danger-hover)] hover:shadow-[var(--shadow-md)] hover:scale-105"
                      >
                        <Icon.stop size={15} />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={!hasContent}
                        className="flex size-9 items-center justify-center rounded-full bg-[var(--accent-gradient)] text-white shadow-[var(--shadow-sm)] transition-all hover:shadow-[var(--shadow-accent)] hover:scale-105 disabled:opacity-30 disabled:hover:scale-100 disabled:hover:shadow-none"
                      >
                        <Icon.send size={17} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ─── Normal state: scrollable messages + bottom input ───────
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      {/* 隐藏文件选择器 — 支持图片+文档全格式 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.odt,.odp,.ods,.rtf,.csv,.md,.txt,.html"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* A-3: 外层 relative 包装，让「回到底部」浮标 absolute 固定在视口底部（不随内容滚动） */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
          <div data-testid="chat-message-column" className="w-full px-4 py-8 sm:px-6 lg:px-10">
            <div className="space-y-6">
              {messages.map((m) => {
                const isUser = m.role === "user";
                const isLastAssistant = !isUser && m.id === messages[messages.length - 1]?.id;
                const isStreamingThis =
                  isLastAssistant && (status === "streaming" || status === "submitted");
                const isEditing = editingId === m.id;
                const isLastUser = isLastUserMessage(m.id);
                return (
                  <div key={m.id}>
                    <MessageRow
                      message={m}
                      isLastAssistant={isLastAssistant}
                      isStreamingThis={isStreamingThis}
                      isEditing={isEditing}
                      isLastUser={isLastUser}
                      editText={editText}
                      busy={busy}
                      onEditTextChange={setEditText}
                      onConfirmEdit={confirmEdit}
                      onCancelEdit={cancelEdit}
                      onStartEdit={startEdit}
                      onCopy={copyMessage}
                      onRegenerate={regenerate}
                      onOpenWorkspace={handleOpenWorkspaceFromMessage}
                    />
                  </div>
                );
              })}
            </div>
            {(status === "submitted" || status === "streaming") && (
              <div className="mt-6 flex justify-start">
                <div className="flex items-center gap-1 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                  <span className="dot size-1.5 rounded-full bg-[var(--fg-subtle)]" />
                  <span className="dot size-1.5 rounded-full bg-[var(--fg-subtle)]" />
                  <span className="dot size-1.5 rounded-full bg-[var(--fg-subtle)]" />
                </div>
              </div>
            )}
          </div>
        </div>
        {/* A-3: 「回到底部」浮标 —— 上滚查看历史时出现，点击回底并恢复流式跟随 */}
        {showScrollToBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label={t("chat.scroll_to_bottom")}
            className="absolute bottom-5 left-1/2 z-10 inline-flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] shadow-[var(--shadow-sm)] transition hover:border-[var(--primary)] hover:text-[var(--fg)]"
          >
            <Icon.chevron size={16} />
          </button>
        )}
      </div>

      <div data-testid="chat-input-column" className="w-full px-4 pb-6 sm:px-6 lg:px-10">
        {/* B-4: 错误提示条（移除重连提示，用户不需要看到技术性状态） */}
        {displayError && (
          <div className="mb-2 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-[13px] text-[var(--danger)]">
            <Icon.warn size={14} className="shrink-0" />
            <span className="flex-1">{displayError}</span>
            {/* A-2: 错误条重试入口 —— regenerate 会重发最后一条 user 消息，
                覆盖网络层失败与 agent 执行失败两种场景。 */}
            <button
              type="button"
              onClick={() => {
                setLastError(null);
                regenerate();
              }}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[12px] font-medium text-[var(--danger)] transition hover:bg-[var(--danger)]/10"
              title={t("common.retry")}
            >
              <Icon.refresh size={12} />
              {t("common.retry")}
            </button>
            <button
              type="button"
              onClick={() => setLastError(null)}
              className="flex size-5 items-center justify-center rounded text-[var(--danger)] transition hover:bg-[var(--danger)]/10"
              title={t("studio.nav.close")}
            >
              <Icon.close size={12} />
            </button>
          </div>
        )}
        <form
          onSubmit={onFormSubmit}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            // D-5: 拖拽文件 → 走上传流程
            handleFiles(Array.from(e.dataTransfer.files));
          }}
          className={`w-full rounded-[var(--radius-lg)] border bg-[var(--surface)] shadow-[var(--shadow-sm)] transition focus-within:shadow-[var(--shadow-md)] ${
            dragging
              ? "border-[var(--primary)] border-dashed"
              : "border-[var(--border)]/60 focus-within:border-[var(--primary)]/50"
          }`}
        >
          {/* 待发送附件预览区 */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap items-start gap-3 border-b border-[var(--border)] px-3 pt-3 pb-2">
              {attachments.map((att) =>
                att.kind === "image" ? (
                  <div key={att.id} className="group relative">
                    <div
                      className="h-20 w-20 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)]"
                      onMouseEnter={() => enterAtt(att.id)}
                      onMouseLeave={() => leaveAtt(att.id)}
                    >
                      <img
                        src={att.url}
                        alt={att.filename}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    {/* hover 向上弹出大图预览（移入弹窗可滚动浏览，移出后 1s 关闭） */}
                    <div
                      className={cn(
                        "absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2",
                        hoveredAttId === att.id ? "block" : "hidden",
                      )}
                      onMouseEnter={() => enterAtt(att.id)}
                      onMouseLeave={() => leaveAtt(att.id)}
                    >
                      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] shadow-[var(--shadow-lg)]">
                        <img
                          src={att.url}
                          alt={att.filename}
                          className="max-h-[40rem] max-w-3xl object-contain"
                        />
                      </div>
                      {/* 箭头 */}
                      <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-[var(--border)] bg-[var(--bg)]" />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(att.id)}
                      className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)] text-[var(--fg-muted)] opacity-0 shadow-sm transition group-hover:opacity-100 hover:border-[var(--danger)] hover:text-[var(--danger)]"
                    >
                      <Icon.close size={12} />
                    </button>
                  </div>
                ) : (
                  <div
                    key={att.id}
                    className="group relative flex h-20 w-40 flex-col justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5"
                    onMouseEnter={() => enterAtt(att.id)}
                    onMouseLeave={() => leaveAtt(att.id)}
                  >
                    <div className="flex items-center gap-2">
                      <Icon.fileText size={16} className="shrink-0 text-[var(--primary)]" />
                      <span className="min-w-0 truncate text-[12px] text-[var(--fg)]">
                        {att.filename}
                      </span>
                    </div>
                    <span className="ml-6 text-[11px] text-[var(--fg-muted)]">
                      {att.charCount.toLocaleString()} 字符
                    </span>
                    {/* hover 向上弹出文件内容预览（移入弹窗可滚动浏览，移出后 1s 关闭） */}
                    <div
                      className={cn(
                        "absolute bottom-full left-0 z-50 mb-2 w-[56rem] max-w-[90vw]",
                        hoveredAttId === att.id ? "block" : "hidden",
                      )}
                      onMouseEnter={() => enterAtt(att.id)}
                      onMouseLeave={() => leaveAtt(att.id)}
                    >
                      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] shadow-[var(--shadow-lg)]">
                        <div className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                          <span className="text-[13px] font-medium text-[var(--fg)]">
                            {att.filename}
                          </span>
                          <span className="ml-2 text-[11px] text-[var(--fg-muted)]">
                            {att.charCount.toLocaleString()} 字符
                          </span>
                        </div>
                        <div className="max-h-[36rem] overflow-auto p-3">
                          <pre className="whitespace-pre-wrap text-[12px] leading-5 text-[var(--fg-muted)]">
                            {att.text.slice(0, 2400)}
                            {att.text.length > 2400 ? "..." : ""}
                          </pre>
                        </div>
                      </div>
                      {/* 箭头 */}
                      <div className="absolute -bottom-1 left-6 h-2 w-2 rotate-45 border-b border-r border-[var(--border)] bg-[var(--bg)]" />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(att.id)}
                      className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)] text-[var(--fg-muted)] opacity-0 shadow-sm transition group-hover:opacity-100 hover:border-[var(--danger)] hover:text-[var(--danger)]"
                    >
                      <Icon.close size={12} />
                    </button>
                  </div>
                ),
              )}
              {uploading && (
                <div className="flex h-10 w-20 items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--border)]">
                  <Icon.spinner size={18} className="animate-spin text-[var(--fg-subtle)]" />
                </div>
              )}
            </div>
          )}

          <textarea
            ref={inputRef}
            className="max-h-44 w-full resize-none bg-transparent px-4 py-3.5 text-[15px] leading-6 outline-none placeholder:text-[var(--fg-subtle)]"
            onChange={handleInputChange}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              // D-5: 粘贴图片 → 走上传流程
              const imgs = Array.from(e.clipboardData.files).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (imgs.length > 0) {
                e.preventDefault();
                handleFiles(imgs);
              }
            }}
            placeholder={
              enterBehavior === "send" ? t("chat.placeholder.send") : t("chat.placeholder.newline")
            }
            rows={1}
            value={input}
          />
          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            <div className="flex min-w-0 items-center gap-1">
              {/* 上传附件按钮 */}
              <button
                type="button"
                title={t("chat.upload.attach")}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className={`flex size-8 shrink-0 items-center justify-center rounded-full transition ${
                  uploading
                    ? "cursor-wait text-[var(--fg-muted)] opacity-50"
                    : "text-[var(--fg-subtle)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
                }`}
              >
                <Icon.plus size={16} />
              </button>

              {/* 当前会话 skill 选择器（从 header 下移到输入框工具栏） */}
              {skill && skills && skills.length > 0 && onSkillChange && (
                <div className="relative">
                  <button
                    type="button"
                    title={skill.description}
                    onClick={() => setSkillOpen((o) => !o)}
                    className="flex max-w-[160px] items-center gap-1.5 truncate rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] text-[var(--fg-muted)] transition hover:border-[var(--primary)]/40 hover:text-[var(--fg)]"
                  >
                    <Icon.sparkles size={12} className="shrink-0 text-[var(--primary)]" />
                    <span className="truncate">{skill.name}</span>
                    <Icon.chevron
                      size={11}
                      className={`shrink-0 transition ${skillOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {skillOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-30"
                        onClick={() => setSkillOpen(false)}
                        onKeyDown={() => setSkillOpen(false)}
                      />
                      <div className="absolute bottom-full left-0 z-40 mb-2 w-[400px] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-lg">
                        <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-[var(--fg-muted)]">
                          选择技能
                        </div>
                        {/* skill 搜索框 */}
                        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
                          <Icon.search size={14} className="shrink-0 text-[var(--fg-subtle)]" />
                          <input
                            // biome-ignore lint/a11y/noAutofocus: 浮层打开时聚焦搜索是预期交互
                            autoFocus
                            value={skillQuery}
                            onChange={(e) => setSkillQuery(e.target.value)}
                            placeholder="搜索技能…"
                            className="w-full bg-transparent text-[13px] outline-none placeholder:text-[var(--fg-subtle)]"
                          />
                          {skillQuery && (
                            <button
                              type="button"
                              onClick={() => setSkillQuery("")}
                              className="text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                              aria-label="清除搜索"
                            >
                              <Icon.close size={12} />
                            </button>
                          )}
                        </div>
                        <div className="max-h-80 overflow-y-auto p-1">
                          <button
                            type="button"
                            onClick={() => {
                              onSkillChange(null);
                              setSkillOpen(false);
                              setSkillQuery("");
                            }}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition hover:bg-[var(--surface-2)] ${skill.id === null ? "text-[var(--primary)]" : "text-[var(--fg)]"}`}
                          >
                            <Icon.check
                              size={14}
                              className={skill.id === null ? "" : "invisible"}
                            />
                            不指定 Skill
                            <span className="ml-auto text-[11px] text-[var(--fg-muted)]">
                              基础 agent
                            </span>
                          </button>
                          {skills
                            .filter(
                              (s) =>
                                s.name.toLowerCase().includes(skillQuery.toLowerCase()) ||
                                s.category?.toLowerCase().includes(skillQuery.toLowerCase()),
                            )
                            .map((s) => (
                              <button
                                key={s.id}
                                type="button"
                                onClick={() => {
                                  onSkillChange(s.id);
                                  setSkillOpen(false);
                                  setSkillQuery("");
                                }}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition hover:bg-[var(--surface-2)] ${skill.id === s.id ? "text-[var(--primary)]" : "text-[var(--fg)]"}`}
                              >
                                <Icon.check
                                  size={14}
                                  className={skill.id === s.id ? "" : "invisible"}
                                />
                                <span className="truncate">{s.name}</span>
                                {s.category && (
                                  <span className="ml-auto shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)]">
                                    {s.category}
                                  </span>
                                )}
                              </button>
                            ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2.5">
              <ModelSelector
                models={models}
                value={selectedModel}
                onChange={onModelChange}
                direction="up"
                compact
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => {
                    stop(); // 中断 SSE fetch（客户端断开）
                    // B-5：真正停止后端执行（runner 仍在跑），调 cancel 端点 abort streamText + flush
                    apiFetch(`/api/threads/${threadId}/cancel`, { method: "POST" }).catch(() => {});
                    // A-6: 停止后回滚乐观状态，避免 UI 停留在「执行中」
                    onStatusChangeRef.current?.(threadId, "idle");
                  }}
                  title={t("chat.stop")}
                  className="flex size-8 items-center justify-center rounded-full border border-[var(--danger)]/25 bg-[var(--danger-soft)] text-[var(--danger)] transition hover:border-[var(--danger)]/40 hover:bg-[var(--danger)]/10"
                >
                  <Icon.stop size={12} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!hasContent}
                  className="flex size-8 items-center justify-center rounded-full bg-[var(--accent-gradient)] text-white shadow-[var(--shadow-sm)] transition-all hover:shadow-[var(--shadow-accent)] hover:scale-105 disabled:opacity-30 disabled:hover:scale-100 disabled:hover:shadow-none"
                >
                  <Icon.send size={16} />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
