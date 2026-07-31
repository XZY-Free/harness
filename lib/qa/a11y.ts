import { qaConfig } from "@/lib/config";
import { type QaFailure, type QaRunner, saveQaReport, saveScreenshot } from "@/lib/qa/artifact";
import { type QaStorageState, openQaPage, viewportOf } from "@/lib/qa/browser";

/**
 * V3.6 Stage C：runAccessibilitySmoke——a11y 烟雾检查（plan §7 / §1 决策）。
 *
 * 明确**烟雾级**（不做完整 axe 规则集）。确定性检查（不调 LLM）：
 * - img alt：图片缺 alt（或 alt="" 的非装饰图——本烟雾级把所有 img 缺 alt 计为违规）。
 * - label 关联：input/select/textarea 无关联 <label>（for/id）且无 aria-label。
 * - 对比度：叶子文本的前景色与祖先背景合成后按 WCAG AA 阈值检查。
 * - Tab 顺序：tabindex > 0（反模式，破坏文档顺序导航）。
 * - landmark：缺 main/header/nav/footer 之一（页面无地标）。
 *
 * 证据：违规列表 JSON + 截图落 artifact。
 */

export interface A11yResult {
  ok: boolean;
  kind: "a11y";
  failures: QaFailure[];
  viewports: number[];
  durationMs: number;
  artifactPath?: string | null;
  runner?: QaRunner;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface A11yProbe {
  imagesWithoutAlt: number;
  controlsWithoutLabel: string[];
  lowContrast: number;
  invisibleText: number;
  badTabindex: number;
  hasLandmark: boolean;
}

// S1（05-P2-1）：WCAG 相对亮度 + 对比度公式。
const A11Y_SCRIPT = `(() => {
  const imgs = Array.from(document.querySelectorAll('img'));
  const imagesWithoutAlt = imgs.filter(i => !i.hasAttribute('alt')).length;
  const controls = Array.from(document.querySelectorAll('input,select,textarea'));
  const controlsWithoutLabel = controls.filter(c => {
    if (c.getAttribute('aria-label') || c.getAttribute('aria-labelledby')) return false;
    const id = c.getAttribute('id');
    if (id && document.querySelector('label[for="' + CSS.escape(id) + '"]')) return false;
    const wrap = c.closest('label');
    if (wrap) return false;
    return true;
  }).map(c => c.tagName.toLowerCase() + (c.getAttribute('name') ? ('[name='+c.getAttribute('name')+']') : ''));
  // 解析 computed color 为 [r,g,b,a]（0-1）。透明背景必须与祖先背景合成，
  // 不能直接把 rgba(0,0,0,0) 当黑色。
  const parseColor = (css) => {
    const m = css.match(/rgba?\\((\\d+)[, ]+(\\d+)[, ]+(\\d+)(?:[, /]+([\\d.]+))?/);
    if (!m) return null;
    return [
      parseInt(m[1],10)/255,
      parseInt(m[2],10)/255,
      parseInt(m[3],10)/255,
      m[4] === undefined ? 1 : parseFloat(m[4]),
    ];
  };
  const blend = (top, bottom) => {
    const alpha = Math.max(0, Math.min(1, top[3]));
    return [
      top[0] * alpha + bottom[0] * (1-alpha),
      top[1] * alpha + bottom[1] * (1-alpha),
      top[2] * alpha + bottom[2] * (1-alpha),
    ];
  };
  const effectiveBackground = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      // background-image / gradient 需要像素采样才能可靠计算。烟雾检查不猜测，
      // 交给截图视觉检查覆盖，避免把渐变上的白字按白底白字误报。
      if (style.backgroundImage !== 'none') return null;
      const color = parseColor(style.backgroundColor);
      if (color) layers.push(color);
    }
    let background = [1,1,1];
    for (let i = layers.length - 1; i >= 0; i--) background = blend(layers[i], background);
    return background;
  };
  const lum = ([r,g,b]) => {
    const f = (c) => c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
  };
  const contrast = (a, b) => {
    const la = lum(a), lb = lum(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  const texts = Array.from(document.querySelectorAll('body *')).filter(el =>
    Array.from(el.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim().length > 0)
  );
  let invisibleText = 0;
  let lowContrast = 0;
  for (const el of texts) {
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) <= 0 || rect.width <= 0 || rect.height <= 0) continue;
    const fg = parseColor(s.color);
    if (!fg || fg[3] <= 0.05) { invisibleText++; continue; }
    const bg = effectiveBackground(el);
    if (!bg) continue;
    const displayedFg = blend(fg, bg);
    const ratio = contrast(displayedFg, bg);
    if (ratio < 1.05) { invisibleText++; continue; }
    const fontSize = parseFloat(s.fontSize) || 16;
    const fontWeight = parseInt(s.fontWeight, 10) || 400;
    const largeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    if (ratio < (largeText ? 3 : 4.5)) lowContrast++;
  }
  const badTabindex = document.querySelectorAll('[tabindex]').length === 0 ? 0
    : Array.from(document.querySelectorAll('[tabindex]')).filter(e => { const t = parseInt(e.getAttribute('tabindex')||'0',10); return t > 0; }).length;
  const hasLandmark = !!(document.querySelector('main,[role="main"],header,nav,footer'));
  return { imagesWithoutAlt, controlsWithoutLabel, lowContrast, invisibleText, badTabindex, hasLandmark };
})()`;

export async function runAccessibilitySmokeUrl(opts: {
  url: string;
  previewToken?: string;
  threadId: string;
  checkId: string;
  viewport?: number;
  /** V9 阶段 9：从 UserBrowserProfile 派生的登录态，用于测试需登录的页面。 */
  storageState?: QaStorageState;
}): Promise<A11yResult> {
  const width = opts.viewport ?? qaConfig.viewports[qaConfig.viewports.length - 1] ?? 1280;
  const start = Date.now();
  const failures: QaFailure[] = [];

  let page: Awaited<ReturnType<typeof openQaPage>> | null = null;
  try {
    page = await openQaPage(viewportOf(width), {
      ...(opts.previewToken ? { headers: { "x-preview-token": opts.previewToken } } : {}),
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    await page.goto(opts.url, qaConfig.timeoutMs);
    let probe: A11yProbe = {
      imagesWithoutAlt: 0,
      controlsWithoutLabel: [],
      lowContrast: 0,
      invisibleText: 0,
      badTabindex: 0,
      hasLandmark: true,
    };
    try {
      probe = await page.evaluate<A11yProbe>(A11Y_SCRIPT);
    } catch (error) {
      failures.push({ type: "evaluate_failed", viewport: width, detail: errMsg(error) });
    }

    const buf = await page.screenshotFullPage().catch(() => null);
    if (buf) await saveScreenshot(opts.threadId, opts.checkId, buf, width);

    if (probe.imagesWithoutAlt > 0) {
      failures.push({
        type: "a11y_img_alt",
        viewport: width,
        detail: `${probe.imagesWithoutAlt} 个 <img> 缺少 alt`,
      });
    }
    for (const sel of probe.controlsWithoutLabel) {
      failures.push({
        type: "a11y_label",
        viewport: width,
        detail: `表单控件 ${sel} 无关联 label / aria-label`,
      });
    }
    if (probe.invisibleText > 0) {
      failures.push({
        type: "a11y_contrast",
        viewport: width,
        detail: `${probe.invisibleText} 个文本元素 color===backgroundColor（不可见）`,
      });
    }
    if (probe.lowContrast > 0) {
      failures.push({
        type: "a11y_contrast",
        viewport: width,
        detail: `${probe.lowContrast} 个文本元素对比度 < 4.5:1（WCAG AA 不达标）`,
      });
    }
    if (probe.badTabindex > 0) {
      failures.push({
        type: "a11y_tabindex",
        viewport: width,
        detail: `${probe.badTabindex} 个元素 tabindex>0（破坏文档顺序导航）`,
      });
    }
    if (!probe.hasLandmark) {
      failures.push({
        type: "a11y_landmark",
        viewport: width,
        detail: "页面无 landmark（main/header/nav/footer）",
      });
    }
  } catch (error) {
    failures.push({ type: "navigation_failed", viewport: width, detail: errMsg(error) });
  } finally {
    await page?.close().catch(() => {});
  }

  const report = { checkId: opts.checkId, url: opts.url, viewport: width, failures };
  const artifactPath = await saveQaReport(opts.threadId, opts.checkId, report);
  return {
    ok: failures.length === 0,
    kind: "a11y",
    failures,
    viewports: [width],
    durationMs: Date.now() - start,
    artifactPath,
    runner: "web-playwright",
  };
}
