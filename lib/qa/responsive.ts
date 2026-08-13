import { qaConfig } from "@/lib/config";
import { type QaFailure, type QaRunner, saveQaReport, saveScreenshot } from "@/lib/qa/artifact";
import { type QaStorageState, openQaPage, viewportOf } from "@/lib/qa/browser";

/**
 * Stage C：runResponsiveCheck——多 viewport 响应式布局断言（plan §7）。
 *
 * 确定性规则（不调 LLM、不做像素 diff）：
 * - 水平溢出：`documentElement.scrollWidth > clientWidth + 1`（允许 1px 舍入）。
 * - 内容不可见：body 无 DOM 节点，或既无文本也无媒体。
 * - 响应式破坏：最小 viewport 溢出但最大 viewport 不溢出 → 移动端未堆叠（layout_break）。
 *
 * 证据：三 viewport 截图 + 断言 JSON 落 artifact。
 */

export interface ResponsiveResult {
  ok: boolean;
  kind: "responsive";
  failures: QaFailure[];
  viewports: number[];
  durationMs: number;
  artifactPath?: string | null;
  runner?: QaRunner;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LayoutProbe {
  scrollWidth: number;
  clientWidth: number;
  nodeCount: number;
  textLength: number;
  hasMedia: boolean;
  /** 可见文本/交互元素互相重叠的对数（getBoundingClientRect 相交）。 */
  overlapCount: number;
  /** text-overflow:ellipsis 且 scrollWidth > clientWidth 的截断元素数。 */
  truncatedCount: number;
}

// 追加重叠检测（可见元素 getBoundingClientRect 两两相交）+ 文本截断检测
// （text-overflow:ellipsis 且子内容溢出）。
const LAYOUT_SCRIPT =
  "(() => {" +
  "const scrollWidth = document.documentElement.scrollWidth;" +
  "const clientWidth = document.documentElement.clientWidth;" +
  "const nodeCount = document.querySelectorAll('*').length;" +
  "const textLength = (document.body && document.body.innerText) ? document.body.innerText.trim().length : 0;" +
  "const hasMedia = document.querySelectorAll('img,video,canvas,svg').length > 0;" +
  // 只比较独立的叶子文本/交互元素。容器与后代天然相交，不属于布局重叠。
  "const visible = Array.from(document.querySelectorAll('a,button,p,h1,h2,h3,h4,li,label,input,select,textarea,th,td')).filter(el => {" +
  "const r = el.getBoundingClientRect(); const s = getComputedStyle(el);" +
  "const hasOwnText = Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent && n.textContent.trim().length > 0);" +
  "const interactive = ['INPUT','SELECT','TEXTAREA'].includes(el.tagName);" +
  "return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0 && r.width > 2 && r.height > 2 && (hasOwnText || interactive);" +
  "}).slice(0,200);" +
  "let overlapCount = 0;" +
  "for (let i = 0; i < visible.length && i < 200; i++) {" +
  "for (let j = i+1; j < visible.length && j < 200; j++) {" +
  "if (visible[i].contains(visible[j]) || visible[j].contains(visible[i])) continue;" +
  "const a = visible[i].getBoundingClientRect(), b = visible[j].getBoundingClientRect();" +
  "const ox = Math.max(0, Math.min(a.right,b.right) - Math.max(a.left,b.left));" +
  "const oy = Math.max(0, Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top));" +
  "const overlapArea = ox * oy; const smallerArea = Math.min(a.width*a.height, b.width*b.height);" +
  "if (overlapArea > 16 && smallerArea > 0 && overlapArea / smallerArea >= 0.2) overlapCount++; } }" +
  // 文本截断检测：text-overflow:ellipsis 且元素内容溢出
  "let truncatedCount = 0;" +
  "Array.from(document.querySelectorAll('*')).forEach(el => {" +
  "const s = getComputedStyle(el);" +
  "if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) truncatedCount++;" +
  "});" +
  "return { scrollWidth, clientWidth, nodeCount, textLength, hasMedia, overlapCount, truncatedCount };" +
  "})()";

function hasOverflow(p: LayoutProbe): boolean {
  return p.scrollWidth > p.clientWidth + 1;
}

function hasNoContent(p: LayoutProbe): boolean {
  return p.nodeCount === 0 || (p.textLength === 0 && !p.hasMedia);
}

export async function runResponsiveCheckUrl(opts: {
  url: string;
  previewToken?: string;
  threadId: string;
  checkId: string;
  viewports?: number[];
  /** V9 阶段 9：从 UserBrowserProfile 派生的登录态，用于测试需登录的页面。 */
  storageState?: QaStorageState;
}): Promise<ResponsiveResult> {
  const viewports = (opts.viewports ?? qaConfig.viewports).slice().sort((a, b) => a - b);
  const start = Date.now();
  const failures: QaFailure[] = [];
  const probes: Array<{ viewport: number; overflow: boolean; noContent: boolean }> = [];

  for (const width of viewports) {
    let page: Awaited<ReturnType<typeof openQaPage>> | null = null;
    try {
      page = await openQaPage(viewportOf(width), {
        ...(opts.previewToken ? { headers: { "x-preview-token": opts.previewToken } } : {}),
        ...(opts.storageState ? { storageState: opts.storageState } : {}),
      });
      await page.goto(opts.url, qaConfig.timeoutMs);
      let probe: LayoutProbe = {
        scrollWidth: 0,
        clientWidth: width,
        nodeCount: 0,
        textLength: 0,
        hasMedia: false,
        overlapCount: 0,
        truncatedCount: 0,
      };
      try {
        probe = await page.evaluate<LayoutProbe>(LAYOUT_SCRIPT);
      } catch (error) {
        failures.push({ type: "evaluate_failed", viewport: width, detail: errMsg(error) });
      }

      const buf = await page.screenshotFullPage().catch(() => null);
      if (buf) await saveScreenshot(opts.threadId, opts.checkId, buf, width);

      const overflow = hasOverflow(probe);
      const noContent = hasNoContent(probe);
      if (overflow) {
        failures.push({
          type: "horizontal_overflow",
          viewport: width,
          detail: `水平溢出：scrollWidth=${probe.scrollWidth} > clientWidth=${probe.clientWidth}`,
        });
      }
      if (noContent) {
        failures.push({
          type: "content_invisible",
          viewport: width,
          detail: "body 无可见内容（无 DOM 节点 / 无文本且无媒体）",
        });
      }
      // 元素重叠检测
      if (probe.overlapCount > 0) {
        failures.push({
          type: "element_overlap",
          viewport: width,
          detail: `${probe.overlapCount} 对可见元素 getBoundingClientRect 相交（疑似布局重叠）`,
        });
      }
      // 文本截断检测
      if (probe.truncatedCount > 0) {
        failures.push({
          type: "text_truncated",
          viewport: width,
          detail: `${probe.truncatedCount} 个 text-overflow:ellipsis 元素内容溢出被截断`,
        });
      }
      probes.push({ viewport: width, overflow, noContent });
    } catch (error) {
      failures.push({ type: "navigation_failed", viewport: width, detail: errMsg(error) });
      probes.push({ viewport: width, overflow: false, noContent: true });
    } finally {
      await page?.close().catch(() => {});
    }
  }

  // 响应式破坏：最小 viewport 溢出但最大 viewport 不溢出 → 移动端未堆叠
  if (probes.length >= 2) {
    const smallest = probes[0];
    const largest = probes[probes.length - 1];
    if (smallest && largest && smallest.overflow && !largest.overflow) {
      failures.push({
        type: "layout_break",
        viewport: smallest.viewport,
        detail: `响应式破坏：移动端(${smallest.viewport})溢出但桌面端(${largest.viewport})不溢出，疑似未堆叠`,
      });
    }
  }

  const report = { checkId: opts.checkId, url: opts.url, viewports, failures, probes };
  const artifactPath = await saveQaReport(opts.threadId, opts.checkId, report);
  return {
    ok: failures.length === 0,
    kind: "responsive",
    failures,
    viewports,
    durationMs: Date.now() - start,
    artifactPath,
    runner: "web-playwright",
  };
}
