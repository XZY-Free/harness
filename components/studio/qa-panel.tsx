import type { ThreadEvent } from "@/lib/db/schema";
import { t } from "@/lib/i18n";

/**
 * V3.6 Stage E：Studio QA 证据面板（只读服务端组件）。
 *
 * 按 checkId 分组展示 QA 检查事件（qa.check_passed / qa.check_failed）：
 * - gate / browser / responsive / a11y / verdict 种类
 * - 失败项（console_error / pageerror / network_http_error / blank / layout / a11y_*）
 * - 截图经 Studio API 代理访问（<img src="/studio/api/threads/{id}/qa?artifact=...">）
 *
 * 截图不暴露文件系统路径（plan §9 / §1 决策）。空状态：「当前会话无 QA 证据」。
 */

interface QaPayload {
  checkId: string;
  kind: string;
  viewports: number[];
  failures?: Array<{
    type: string;
    viewport?: number;
    detail: string;
    artifactPath?: string | null;
  }>;
  durationMs: number;
  artifactPath?: string | null;
}

const KIND_LABEL: Record<string, string> = {
  gate: "QA Gate",
  browser: "浏览器检查",
  responsive: "响应式检查",
  a11y: "a11y 烟雾检查",
  verdict: "视觉评审",
};

const FAILURE_LABEL: Record<string, string> = {
  console_error: "Console Error",
  pageerror: "未捕获异常",
  not_found_404: "404 资源缺失",
  network_http_error: "HTTP 资源失败",
  blank: "白屏",
  horizontal_overflow: "水平溢出",
  content_invisible: "内容不可见",
  responsive_broken: "响应式破坏",
  a11y_img_alt: "img 缺 alt",
  a11y_label: "表单缺 label",
  a11y_contrast: "对比度不足",
  a11y_tab_order: "Tab 顺序异常",
  a11y_landmark: "landmark 缺失",
  visual_verdict: "视觉评审失败",
  browser_unavailable: "浏览器不可用",
  navigation_failed: "导航失败",
  evaluate_failed: "页面求值失败",
};

export function QaPanel({ threadId, events }: { threadId: string; events: ThreadEvent[] }) {
  if (events.length === 0) {
    return <div className="text-[13px] text-[var(--fg-muted)]">{t("studio.qa.empty")}</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {events.map((e) => {
        const p = e.payload as unknown as QaPayload;
        const passed = e.type === "qa.check_passed";
        const failures = p.failures ?? [];
        const screenshotNames = extractScreenshotNames(p, failures);

        return (
          <div
            key={e.id}
            className={`rounded-[var(--radius-sm)] border px-4 py-3 text-[13px] ${
              passed
                ? "border-[var(--ok)]/30 bg-[var(--surface)]"
                : "border-[var(--danger)]/30 bg-[var(--surface)]"
            }`}
          >
            {/* header */}
            <div className="flex items-center gap-2">
              <span
                className={`font-medium ${passed ? "text-[var(--ok)]" : "text-[var(--danger)]"}`}
              >
                {passed ? t("studio.qa.passed") : t("studio.qa.failed")}
              </span>
              <span className="text-[var(--fg-muted)]">{KIND_LABEL[p.kind] ?? p.kind}</span>
              <span className="font-mono text-[12px] text-[var(--fg-subtle)]">{p.checkId}</span>
              <span className="ml-auto text-[12px] text-[var(--fg-subtle)]">
                {new Date(e.createdAt).toLocaleTimeString()} · {p.durationMs}ms
              </span>
            </div>

            {/* viewports */}
            {p.viewports.length > 0 && (
              <div className="mt-1 text-[12px] text-[var(--fg-subtle)]">
                {t("studio.qa.viewports")}: {p.viewports.join(" / ")}
              </div>
            )}

            {/* failures */}
            {failures.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {failures.map((f, i) => (
                  <li
                    key={`${f.type}-${f.viewport ?? i}`}
                    className="flex items-start gap-2 text-[12px]"
                  >
                    <span className="shrink-0 text-[var(--danger)]">
                      {FAILURE_LABEL[f.type] ?? f.type}
                      {f.viewport ? `@${f.viewport}` : ""}
                    </span>
                    <span className="flex-1 text-[var(--fg-muted)]">{f.detail}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* screenshots */}
            {screenshotNames.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {screenshotNames.map((name) => (
                  <img
                    key={name}
                    src={`/studio/api/threads/${threadId}/qa?artifact=${encodeURIComponent(name)}`}
                    alt={name}
                    className="max-h-48 rounded-[var(--radius-sm)] border border-[var(--border)]"
                    loading="lazy"
                  />
                ))}
              </div>
            )}

            {/* report JSON link */}
            {p.artifactPath && (
              <div className="mt-2">
                <a
                  href={`/studio/api/threads/${threadId}/qa?artifact=${encodeURIComponent(p.artifactPath)}`}
                  className="text-[12px] text-[var(--primary)] hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("studio.qa.report_json")}
                </a>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 从 payload + failures 提取截图文件名。
 * S1（05-P2-5）：viewports 非空按 checkId-{viewport}.png 推导；viewports 为空（如 verdict）时
 * 直接用 artifactPath（verdict 的 artifactPath 即截图本身），原实现推导不出导致 verdict 截图不展示。
 */
function extractScreenshotNames(p: QaPayload, failures: Array<{ viewport?: number }>): string[] {
  if (p.viewports.length === 0) {
    return p.artifactPath?.endsWith(".png") ? [p.artifactPath] : [];
  }
  const viewportsWithScreenshots = new Set<number>();
  for (const f of failures) {
    if (f.viewport) viewportsWithScreenshots.add(f.viewport);
  }
  for (const v of p.viewports) {
    viewportsWithScreenshots.add(v);
  }
  return Array.from(viewportsWithScreenshots).map((v) => `${p.checkId}-${v}.png`);
}
