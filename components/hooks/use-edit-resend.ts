import { useCallback, useEffect, useRef, useState } from "react";

/**
 * S1（12-P1-1）：编辑重发 hook——从 chat-panel 抽出，封装时序绕过逻辑。
 *
 * 原实现内嵌在 chat-panel.tsx（pendingReplaceRef + pendingSend + useEffect），
 * 依赖 AI SDK v6 setMessages + sendMessage 的时序：setMessages 截断后必须等
 * AI SDK 内部应用生效再 sendMessage，否则内部状态不一致导致静默失败。
 *
 * 本 hook 封装完整编辑重发流程：
 * 1. startEditResend({ replaceFromId, truncatedMessages, newText })
 *    - 记录 replaceFromId（transport 读取后传给后端删除旧消息）
 *    - 调 setMessages(truncatedMessages) 截断
 *    - 标记 pending，触发 effect
 * 2. 内部 useEffect 检测 pending → sendMessage({ role:"user", parts:[{type:"text", text}] })
 *    + 清 pending + onSend()
 * 3. replaceFromRef 暴露给 transport 的 prepareSendMessagesRequest 闭包读取
 *
 * 用法：
 *   const { startEditResend, replaceFromRef, isPending } = useEditResend({
 *     setMessages, sendMessage, onSend: () => onStatusChange?.("executing"),
 *   });
 *   // transport 闭包内读 replaceFromRef.current
 *   // confirmEdit 内调 startEditResend({ replaceFromId: editingId, truncatedMessages, newText })
 */
export function useEditResend<TMessage>({
  setMessages,
  sendMessage,
  onSend,
  replaceFromRef: externalReplaceFromRef,
}: {
  // setMessages 接受新数组或 updater 函数（AI SDK useChat 的 setMessages 签名）
  setMessages: (msgs: TMessage[] | ((prev: TMessage[]) => TMessage[])) => void;
  sendMessage: (opts: { role: "user"; parts: Array<{ type: "text"; text: string }> }) => void;
  onSend?: () => void;
  /** 可选外部 ref——当 transport 闭包需在 hook 之前持有 ref 时传入（chat-panel 场景） */
  replaceFromRef?: React.MutableRefObject<string | null>;
}): {
  /** 触发编辑重发：截断消息 + 标记 pending（effect 内 send） */
  startEditResend: (args: {
    replaceFromId: string;
    truncatedMessages: TMessage[];
    newText: string;
  }) => void;
  /** transport 闭包读取的被替换旧消息 id（读取后自动清空） */
  replaceFromRef: React.MutableRefObject<string | null>;
  /** 是否有待发送的编辑内容（调试/UI 用） */
  isPending: boolean;
} {
  // 被替换的旧消息 id — transport 的 prepareSendMessagesRequest 闭包读取后传后端删除
  // 外部传入则复用（chat-panel 需 ref 先于 transport 存在）；否则自建
  const internalRef = useRef<string | null>(null);
  const replaceFromRef = externalReplaceFromRef ?? internalRef;
  // 待发送的编辑文本 — 用 state 触发 effect，确保 setMessages 应用后再 sendMessage
  const [pendingSend, setPendingSend] = useState<string | null>(null);

  const startEditResend = useCallback(
    (args: { replaceFromId: string; truncatedMessages: TMessage[]; newText: string }) => {
      replaceFromRef.current = args.replaceFromId;
      setMessages(args.truncatedMessages);
      setPendingSend(args.newText);
    },
    [setMessages, replaceFromRef],
  );

  // onSend 用 ref 持有，避免 effect 依赖不稳定
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  // 编辑重新生成：setMessages 截断生效后再 sendMessage，避免 AI SDK 内部状态不一致
  useEffect(() => {
    if (pendingSend === null) return;
    sendMessage({ role: "user", parts: [{ type: "text", text: pendingSend }] });
    setPendingSend(null);
    onSendRef.current?.();
  }, [pendingSend, sendMessage]);

  return { startEditResend, replaceFromRef, isPending: pendingSend !== null };
}
