import { qaConfig } from "@/lib/config";
import { type QaRunner, saveScreenshot } from "@/lib/qa/artifact";
import { type QaStorageState, openQaPage, viewportOf } from "@/lib/qa/browser";

/**
 * V3.6 Stage B：capturePreview——打开 preview url + 全页截图 + 落 artifact（plan §6）。
 *
 * 确定性：截图经真实浏览器渲染，无 LLM。viewport 缺省取 qaConfig.viewports 末档（desktop）。
 * 失败（导航超时 / 浏览器不可用）→ { ok:false, error }，不抛。
 */

export interface CaptureResult {
  ok: boolean;
  viewport: number;
  durationMs: number;
  screenshotPath?: string | null;
  error?: string;
  runner?: QaRunner;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function capturePreviewUrl(opts: {
  url: string;
  previewToken?: string;
  threadId: string;
  checkId: string;
  viewport?: number;
  /** V9 阶段 9：从 UserBrowserProfile 派生的登录态，用于测试需登录的页面。 */
  storageState?: QaStorageState;
}): Promise<CaptureResult> {
  const viewports = qaConfig.viewports;
  const width = opts.viewport ?? viewports[viewports.length - 1] ?? 1280;
  const start = Date.now();
  let page: Awaited<ReturnType<typeof openQaPage>> | null = null;
  try {
    page = await openQaPage(viewportOf(width), {
      ...(opts.previewToken ? { headers: { "x-preview-token": opts.previewToken } } : {}),
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    await page.goto(opts.url, qaConfig.timeoutMs);
    const buf = await page.screenshotFullPage();
    const screenshotPath = await saveScreenshot(opts.threadId, opts.checkId, buf, width);
    return {
      ok: true,
      viewport: width,
      durationMs: Date.now() - start,
      screenshotPath,
      runner: "web-playwright",
    };
  } catch (error) {
    return {
      ok: false,
      viewport: width,
      durationMs: Date.now() - start,
      error: errMsg(error),
      runner: "web-playwright",
    };
  } finally {
    await page?.close().catch(() => {});
  }
}
