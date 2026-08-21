import { randomUUID } from "node:crypto";
import { qaConfig } from "@/lib/config";
import type { RuntimeType } from "@/lib/config";
import { writeThreadEvents } from "@/lib/conversations/thread-queries";
import type { QaGateResult, QaRunner } from "@/lib/desktop/qa-schema";
import { logger } from "@/lib/logger";
import { runAccessibilitySmokeUrl } from "@/lib/qa/a11y";
import { type QaFailure, buildQaFailedPayload, buildQaPassedPayload } from "@/lib/qa/artifact";
import { isBrowserAvailable } from "@/lib/qa/browser";
import { runBrowserCheckUrl } from "@/lib/qa/browser-check";
import { runResponsiveCheckUrl } from "@/lib/qa/responsive";

/**
 * Stage D：QA gate——确定性浏览器质量门（plan §8 / §1 决策）。
 *
 * 命门：
 * - **默认启用**（`qaConfig.enabled=true`，S1 修复 05-注释与 config 默认值对齐）。
 * `qaConfig.enabled=false` → 返回 `{ ok:true, skipped:true }`（零回归）。
 * - **启用即 fail-closed**：启用且 Playwright 浏览器不可用时，`QA_BROWSER_REQUIRED=true`（默认）
 * → 返回明确错误阻断交付，绝不静默跳过。
 * - **不调 LLM**：gate 全走确定性规则（browser-check 的 console/pageerror/404/白屏 +
 * S1 修复 05-按 qaConfig.gateRules 可选追加 responsive/a11y），不依赖 `visualVerdict`。
 *
 * 事件写入（正式链）：`qa.check_passed` / `qa.check_failed` 是员工会话时间线事实，
 * 经唯一正式事件写入口 `writeThreadEvents(tenantId, threadId, ...)` 写正式 threadEventTable
 * （actor=service）。本模块不再写 legacy threadEvent，也不做旧 Thread 状态升级：
 * - `needs_human_review`（旧 thread.reviewState）与 `agent.status_changed` 是旧 Thread
 *   `executing→failed` 状态机副作用；正式 Thread 无此状态机，runQaGate 当前亦无生产调用者
 *   （其 Stage D 集成点 reportThreadReady 不存在）。"连续失败转人工复核"能力后续在正式
 *   Review / Evaluation Authority 上承接，本批不保留 legacy 副作用。
 */
export async function runQaGate(opts: {
  tenantId: string;
  threadId: string;
  previewUrl: string;
  previewToken?: string;
  runtimeType?: RuntimeType;
}): Promise<QaGateResult> {
  const start = Date.now();
  // ：Web Playwright runner（Desktop 端另有等价 QA 实现）
  const runner: QaRunner = "web-playwright";

  // 命门 1：默认禁用 → 零回归
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
      await writeThreadEvents(opts.tenantId, opts.threadId, [
        {
          eventType: "qa.check_failed",
          actorType: "service",
          actorId: runner,
          payload: buildQaFailedPayload({
            checkId,
            kind: "gate",
            viewports: [],
            durationMs: Date.now() - start,
            failures: [{ type: "browser_unavailable", detail: error }],
            runner,
          }),
        },
      ]);
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

  // 按 qaConfig.gateRules 追加 responsive / a11y 检查
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
      // ：a11y 结果统一用 `failures`（原 `violations` 已重命名）
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
    await writeThreadEvents(opts.tenantId, opts.threadId, [
      {
        eventType: "qa.check_passed",
        actorType: "service",
        actorId: runner,
        payload: buildQaPassedPayload({
          checkId,
          kind: "gate",
          viewports: viewportsArr,
          durationMs: totalDuration,
          artifactPath: result.artifactPath,
          runner,
        }),
      },
    ]);
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
  await writeThreadEvents(opts.tenantId, opts.threadId, [
    {
      eventType: "qa.check_failed",
      actorType: "service",
      actorId: runner,
      payload: buildQaFailedPayload({
        checkId,
        kind: "gate",
        viewports: viewportsArr,
        durationMs: totalDuration,
        failures: allFailures,
        artifactPath: result.artifactPath,
        runner,
      }),
    },
  ]);

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
