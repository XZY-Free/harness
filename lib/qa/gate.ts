import { randomUUID } from "node:crypto";
import { qaConfig } from "@/lib/config";
import type { RuntimeType } from "@/lib/config";
import {
  appendThreadEvent,
  countConsecutiveQaGateFailures,
  updateThreadReviewState,
} from "@/lib/db/queries";
import type { QaGateResult, QaRunner } from "@/lib/desktop/qa-schema";
import { logger } from "@/lib/logger";
import { runAccessibilitySmokeUrl } from "@/lib/qa/a11y";
import { type QaFailure, buildQaFailedPayload, buildQaPassedPayload } from "@/lib/qa/artifact";
import { isBrowserAvailable } from "@/lib/qa/browser";
import { runBrowserCheckUrl } from "@/lib/qa/browser-check";
import { runResponsiveCheckUrl } from "@/lib/qa/responsive";

/**
 * V3.6 Stage D：QA gate——reportThreadReady 在 probe 通过后、ready_for_review 前跑的
 * 确定性浏览器质量门（plan §8 / §1 决策）。
 *
 * 命门：
 * - **默认启用**（`qaConfig.enabled=true`，S1 修复 05-P1-8：注释与 config 默认值对齐）。
 *   `qaConfig.enabled=false` → 返回 `{ ok:true, skipped:true }`（零回归）。
 * - **启用即 fail-closed**：启用且 Playwright 浏览器不可用时，`QA_BROWSER_REQUIRED=true`（默认）
 *   → 返回明确错误阻断交付，绝不静默跳过。
 * - **不调 LLM**：gate 全走确定性规则（browser-check 的 console/pageerror/404/白屏 +
 *   S1 修复 05-P1-3：按 qaConfig.gateRules 可选追加 responsive/a11y），不依赖 `visualVerdict`。
 * - gate 失败与 `runVerifyBeforeDelivery` / `probePreviewUrl` 失败同语义：
 *   `previewUrl=null`、`status=executing`、回灌 agent。
 */
export async function runQaGate(opts: {
  threadId: string;
  previewUrl: string;
  previewToken?: string;
  runtimeType?: RuntimeType;
}): Promise<QaGateResult> {
  const start = Date.now();
  // V10 Phase 7-5：Web Playwright runner（Desktop 端另有等价 QA 实现）
  const runner: QaRunner = "web-playwright";

  // 命门 1：默认禁用 → 零回归（reportThreadReady 不受影响）
  if (!qaConfig.enabled) {
    return { ok: true, skipped: true, kind: "gate", durationMs: 0, runner };
  }

  // 命门 2：启用且浏览器不可用 → fail-closed（不静默跳过）
  const available = await isBrowserAvailable();
  if (!available) {
    if (qaConfig.browserRequired) {
      const error =
        "QA gate 启用但 Playwright 浏览器不可用（fail-closed）——请运行 pnpm playwright install";
      logger.warn("[qa] gate fail-closed: browser unavailable", {
        threadId: opts.threadId,
      });
      const checkId = `gate-${randomUUID().slice(0, 8)}`;
      await appendThreadEvent(
        opts.threadId,
        "qa.check_failed",
        buildQaFailedPayload({
          checkId,
          kind: "gate",
          viewports: [],
          durationMs: Date.now() - start,
          failures: [{ type: "browser_unavailable", detail: error }],
          runner,
        }),
      );
      return {
        ok: false,
        skipped: false,
        kind: "gate",
        error,
        durationMs: Date.now() - start,
        runner,
      };
    }
    // browserRequired=false → 跳过（不推荐，会让 gate 形同虚设）
    logger.warn("[qa] gate skipped: browser unavailable but browserRequired=false", {
      threadId: opts.threadId,
    });
    return { ok: true, skipped: true, kind: "gate", durationMs: Date.now() - start, runner };
  }

  // 启用且可用 → 跑确定性浏览器检查（console error / pageerror / 404 / 白屏）
  // 复用 runBrowserCheckUrl，gate 不重新发明规则、不调 LLM。
  const checkId = `gate-${randomUUID().slice(0, 8)}`;
  const result = await runBrowserCheckUrl({
    url: opts.previewUrl,
    previewToken: opts.previewToken,
    threadId: opts.threadId,
    checkId,
    viewports: qaConfig.viewports,
  });

  // S1 修复（05-P1-3）：按 qaConfig.gateRules 追加 responsive / a11y 检查
  // （原 gate 只跑 browser-check 子集，移动端溢出/表单缺 label 仍能交付）
  const gateRules = qaConfig.gateRules;
  const extraFailures: QaFailure[] = [];
  const allViewports = new Set(result.viewports);
  if (gateRules.includes("responsive")) {
    try {
      const resp = await runResponsiveCheckUrl({
        url: opts.previewUrl,
        previewToken: opts.previewToken,
        threadId: opts.threadId,
        checkId: `${checkId}-resp`,
        viewports: qaConfig.viewports,
      });
      extraFailures.push(...resp.failures);
      for (const v of resp.viewports) allViewports.add(v);
    } catch (error) {
      logger.warn("[qa] gate responsive 检查失败（fail-open）", {
        threadId: opts.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (gateRules.includes("a11y")) {
    try {
      const a11y = await runAccessibilitySmokeUrl({
        url: opts.previewUrl,
        previewToken: opts.previewToken,
        threadId: opts.threadId,
        checkId: `${checkId}-a11y`,
        viewport: qaConfig.viewports[qaConfig.viewports.length - 1] ?? 1280,
      });
      // V10 Phase 7-5：a11y 结果统一用 `failures`（原 `violations` 已重命名）
      extraFailures.push(...a11y.failures);
      for (const v of a11y.viewports) allViewports.add(v);
    } catch (error) {
      logger.warn("[qa] gate a11y 检查失败（fail-open）", {
        threadId: opts.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const allFailures = [...result.failures, ...extraFailures];
  const allOk = result.ok && extraFailures.length === 0;
  const viewportsArr = [...allViewports];
  const totalDuration = Date.now() - start;

  if (allOk) {
    await appendThreadEvent(
      opts.threadId,
      "qa.check_passed",
      buildQaPassedPayload({
        checkId,
        kind: "gate",
        viewports: viewportsArr,
        durationMs: totalDuration,
        artifactPath: result.artifactPath,
        runner,
      }),
    );
    return {
      ok: true,
      skipped: false,
      kind: "gate",
      evidencePath: result.artifactPath,
      durationMs: totalDuration,
      runner,
    };
  }

  // gate 失败 → 写 qa.check_failed 事件 + 返回明确错误
  await appendThreadEvent(
    opts.threadId,
    "qa.check_failed",
    buildQaFailedPayload({
      checkId,
      kind: "gate",
      viewports: viewportsArr,
      durationMs: totalDuration,
      failures: allFailures,
      artifactPath: result.artifactPath,
      runner,
    }),
  );

  // P1 修复（05 QA P1-1）：gate 连续失败重试上限。
  // 统计连续失败次数,超 maxConsecutiveFailures → 转人工审核,停止 agent 自动重试。
  // 防 agent 改一点 → gate 再失败 → 再改的无限循环烧 token。
  try {
    const consecutiveFailures = await countConsecutiveQaGateFailures(opts.threadId);
    if (consecutiveFailures >= qaConfig.maxConsecutiveFailures) {
      await updateThreadReviewState(opts.threadId, "needs_human_review");
      logger.warn("[qa] gate 连续失败超上限,转人工审核", {
        threadId: opts.threadId,
        consecutiveFailures,
        maxConsecutiveFailures: qaConfig.maxConsecutiveFailures,
      });
      // 事件标记转人工,供前端展示与 agent 提示
      await appendThreadEvent(opts.threadId, "agent.status_changed", {
        from: "executing",
        to: "failed",
        reason: "qa_gate_consecutive_failures",
        consecutiveFailures,
      });
    }
  } catch (error) {
    // 重试上限判定失败不阻断 gate 失败本身(fail-open,审计逻辑非关键路径)
    logger.warn("[qa] gate 连续失败统计失败（fail-open）", {
      threadId: opts.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const error = `QA gate 未过：${allFailures
    .map((f) => `${f.type}${f.viewport ? `@${f.viewport}` : ""}`)
    .join(", ")}`;
  return {
    ok: false,
    skipped: false,
    kind: "gate",
    failures: allFailures,
    error,
    evidencePath: result.artifactPath,
    durationMs: totalDuration,
    runner,
  };
}
