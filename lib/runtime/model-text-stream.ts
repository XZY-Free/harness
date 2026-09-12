interface ModelStreamPart {
  readonly type: string;
  readonly text?: string;
  readonly error?: unknown;
  readonly finishReason?: string;
}

export interface CollectedModelText {
  readonly text: string;
  /** 模型流终结原因；流未携带 finish part 时为 "unknown"（视为异常结束）。 */
  readonly finishReason: string;
}

/** 异常终结原因：截断/内容过滤/连接早断等，调用方须重试或按失败关闭，不得静默接受。 */
export const TRUNCATED_FINISH_REASONS = new Set(["length", "content-filter", "other", "unknown"]);

/**
 * 消费 AI SDK 完整事件流。
 *
 * `textStream` 会忽略 error 事件，因此上游 4xx/5xx 可能被误判为“成功但正文为空”。
 * 正式执行链必须读取 fullStream，并把错误或空正文按失败关闭。
 * 同时捕获 finish part 的 finishReason：流早断（无 finish 或 reason 异常）时
 * 返回标记由调用方决定重试/失败，杜绝“截断正文被当完整回答”的状态说谎。
 */
export async function collectModelText(
  parts: AsyncIterable<ModelStreamPart>,
  emitTextDelta?: (delta: string) => Promise<void>,
): Promise<CollectedModelText> {
  let text = "";
  let finishReason = "unknown";
  for await (const part of parts) {
    if (part.type === "error") throw part.error;
    if (part.type === "finish") {
      finishReason = part.finishReason ?? "stop";
      continue;
    }
    if (part.type !== "text-delta" || !part.text) continue;
    text += part.text;
    await emitTextDelta?.(part.text);
  }
  if (!text.trim()) throw new Error("模型未返回正文");
  return { text, finishReason };
}
