/**
 * 预览探活工具(从 lib/ai/preview-gate.ts 抽出,避免 DevServerPreviewRuntime
 * 与 preview-gate 的循环 import)。
 *
 * 供 reportThreadReady(交付探活)与 DevServerPreviewRuntime.ready 探测共用同一判据:
 * HTTP 200 + 非空 + 有效 HTML 文档特征。
 */
export async function probePreviewUrl(
  url: string,
  opts?: {
    /** 超时 ms，默认 10s。 */
    timeoutMs?: number;
    /** 静态预览鉴权 token（带 x-preview-token 头）。 */
    token?: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const headers: HeadersInit = {};
  if (opts?.token) headers["x-preview-token"] = opts.token;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  } catch (error) {
    return { ok: false, error: `探活失败：${(error as Error).message}` };
  }

  if (response.status !== 200) {
    return { ok: false, error: `探活失败：HTTP ${response.status}` };
  }

  const html = (await response.text()).trim();
  if (!html) {
    return { ok: false, error: "探活失败：响应体为空" };
  }

  if (!/<!doctype|<html|<body/i.test(html)) {
    return { ok: false, error: "探活失败：响应不是有效 HTML 文档" };
  }

  return { ok: true };
}
