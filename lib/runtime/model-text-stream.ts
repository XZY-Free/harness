interface ModelStreamPart {
  readonly type: string;
  readonly text?: string;
  readonly error?: unknown;
}

/**
 * 消费 AI SDK 完整事件流。
 *
 * `textStream` 会忽略 error 事件，因此上游 4xx/5xx 可能被误判为“成功但正文为空”。
 * 正式执行链必须读取 fullStream，并把错误或空正文按失败关闭。
 */
export async function collectModelText(
  parts: AsyncIterable<ModelStreamPart>,
  emitTextDelta?: (delta: string) => Promise<void>,
): Promise<string> {
  let text = "";
  for await (const part of parts) {
    if (part.type === "error") throw part.error;
    if (part.type !== "text-delta" || !part.text) continue;
    text += part.text;
    await emitTextDelta?.(part.text);
  }
  if (!text.trim()) throw new Error("模型未返回正文");
  return text;
}
