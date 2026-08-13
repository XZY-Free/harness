/**
 * 会话标题清洗与兜底生成。
 *
 * LLM 标题生成是体验增强，不应因为模型临时失败导致 thread 永久停留在“新会话”。
 */

export function normalizeThreadTitle(input: string): string {
  return input
    .replace(/["'`“”‘’「」『』]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(用户|助手)\s*[:：]\s*/, "")
    .replace(/[。！？!?，,、；;：:\s]+$/g, "")
    .trim()
    .slice(0, 30);
}

function looksLikeRequestEcho(title: string): boolean {
  return /^(帮我|请帮我|麻烦你|请你|给我|我想要|我想|我要|做一个|做个|生成一个|生成个|创建一个|创建个|写一个|写个)/.test(
    title,
  );
}

export function chooseThreadTitle(generatedText: string, fallbackTitle: string): string {
  const title = normalizeThreadTitle(generatedText);
  if (!title) return fallbackTitle;
  if (fallbackTitle && looksLikeRequestEcho(title)) return fallbackTitle;
  return title;
}

export function fallbackTitleFromUserText(input: string): string {
  const text = normalizeThreadTitle(input);
  if (!text) return "";

  const withoutPolitePrefix = text
    .replace(/^(帮我|请帮我|麻烦你|请你|给我|我想要|我想|我要)/, "")
    .replace(/^(做一个|做个|生成一个|生成个|创建一个|创建个|写一个|写个)/, "")
    .trim();

  const firstClause = withoutPolitePrefix.split(/[，,。.!！?？；;]/)[0]?.trim() ?? "";
  return normalizeThreadTitle(firstClause || text).slice(0, 16);
}
