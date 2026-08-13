import { randomUUID } from "node:crypto";
import { executeToolRun } from "@/lib/ai/tool-runtime";
import type { RuntimeType } from "@/lib/config";
import { appendThreadEvent } from "@/lib/db/queries";
import type { QaRunner } from "@/lib/desktop/qa-schema";
import { type A11yResult, runAccessibilitySmokeUrl } from "@/lib/qa/a11y";
import {
  type QaCheckKind,
  type QaFailure,
  buildQaFailedPayload,
  buildQaPassedPayload,
} from "@/lib/qa/artifact";
import { type BrowserCheckResult, runBrowserCheckUrl } from "@/lib/qa/browser-check";
import { type CaptureResult, capturePreviewUrl } from "@/lib/qa/capture";
import { type ResponsiveResult, runResponsiveCheckUrl } from "@/lib/qa/responsive";
import { type VisualVerdict, visualVerdict } from "@/lib/qa/visual-verdict";
import type { RuntimeHandle } from "@/lib/runtime/types";
import { tool } from "ai";
import { z } from "zod";

/**
 * ：Web Playwright runner 标识。
 * 所有 QA 工具产出的 qa.check_passed/failed 事件 payload 都带此 runner 字段，
 * 便于审计区分 Web 端与未来 Desktop CDP 端的 QA 产出。
 */
const QA_RUNNER: QaRunner = "web-playwright";

/**
 * Stage B/C：浏览器 QA 工具五件套（plan §6/§7）。
 *
 * 全部经 `executeToolRun` 收口（落 tool_runs + tool.* 事件），并额外追加 `qa.check_passed/failed`
 * 审计事件（kind=browser/responsive/a11y/verdict，区分于 gate 自动跑的 kind=gate）。
 *
 * preview url 来源：`resolveRuntimes(...).preview.start(threadId)` 返回的 localhost url
 * （container 模式为映射端口，host 侧浏览器可达）。preview.start 幂等（已启动则复用）。
 *
 * 确定性：capturePreview/runBrowserCheck 全用确定性规则，不调 LLM。
 * visualVerdict（Stage C）是 agent 可选自检工具，可调 LLM，但 **gate 不依赖它**。
 */

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ：QA storageState 派生已移除（原 V9 从 UserBrowserProfile 解密登录态）。
// Web 端 QA 现在以未登录态运行；Desktop QA 隐藏 WebContents 再经 RPC 派生。

/** 按 BrowserCheckResult 追加 qa 事件（passed/failed）。 */
async function emitBrowserCheckEvent(
  threadId: string,
  checkId: string,
  kind: QaCheckKind,
  result: BrowserCheckResult,
): Promise<void> {
  if (result.ok) {
    await appendThreadEvent(
      threadId,
      "qa.check_passed",
      buildQaPassedPayload({
        checkId,
        kind,
        viewports: result.viewports,
        durationMs: result.durationMs,
        artifactPath: result.artifactPath,
        runner: QA_RUNNER,
      }),
    );
  } else {
    await appendThreadEvent(
      threadId,
      "qa.check_failed",
      buildQaFailedPayload({
        checkId,
        kind,
        viewports: result.viewports,
        failures: result.failures,
        durationMs: result.durationMs,
        artifactPath: result.artifactPath,
        runner: QA_RUNNER,
      }),
    );
  }
}

/** 按 CaptureResult 追加 qa 事件（截图自检，passed/failed）。 */
async function emitCaptureEvent(
  threadId: string,
  checkId: string,
  result: CaptureResult,
): Promise<void> {
  if (result.ok) {
    await appendThreadEvent(
      threadId,
      "qa.check_passed",
      buildQaPassedPayload({
        checkId,
        kind: "browser",
        viewports: [result.viewport],
        durationMs: result.durationMs,
        artifactPath: result.screenshotPath,
        runner: QA_RUNNER,
      }),
    );
  } else {
    await appendThreadEvent(
      threadId,
      "qa.check_failed",
      buildQaFailedPayload({
        checkId,
        kind: "browser",
        viewports: [result.viewport],
        failures: [
          { type: "capture_failed", viewport: result.viewport, detail: result.error ?? "截图失败" },
        ],
        durationMs: result.durationMs,
        runner: QA_RUNNER,
      }),
    );
  }
}

/** 按 ResponsiveResult 追加 qa 事件（passed/failed）。 */
async function emitResponsiveEvent(
  threadId: string,
  checkId: string,
  result: ResponsiveResult,
): Promise<void> {
  const base = {
    checkId,
    kind: "responsive" as QaCheckKind,
    viewports: result.viewports,
    durationMs: result.durationMs,
    artifactPath: result.artifactPath,
    runner: QA_RUNNER,
  };
  if (result.ok) {
    await appendThreadEvent(threadId, "qa.check_passed", buildQaPassedPayload(base));
  } else {
    await appendThreadEvent(
      threadId,
      "qa.check_failed",
      buildQaFailedPayload({ ...base, failures: result.failures }),
    );
  }
}

/** 按 A11yResult 追加 qa 事件（passed/failed）。 */
async function emitA11yEvent(threadId: string, checkId: string, result: A11yResult): Promise<void> {
  const base = {
    checkId,
    kind: "a11y" as QaCheckKind,
    viewports: result.viewports,
    durationMs: result.durationMs,
    artifactPath: result.artifactPath,
    runner: QA_RUNNER,
  };
  if (result.ok) {
    await appendThreadEvent(threadId, "qa.check_passed", buildQaPassedPayload(base));
  } else {
    await appendThreadEvent(
      threadId,
      "qa.check_failed",
      buildQaFailedPayload({ ...base, failures: result.failures }),
    );
  }
}

/** 按 VisualVerdict 追加 qa 事件（kind=verdict，passed/failed by blank/layout）。 */
async function emitVerdictEvent(
  threadId: string,
  checkId: string,
  screenshotPath: string,
  verdict: VisualVerdict & { ok: boolean },
): Promise<void> {
  const failed =
    verdict.blank || verdict.layout === "broken" || verdict.misalignment === "detected";
  const base = {
    checkId,
    kind: "verdict" as QaCheckKind,
    viewports: [],
    durationMs: 0,
    artifactPath: screenshotPath,
    runner: QA_RUNNER,
  };
  if (!failed) {
    await appendThreadEvent(
      threadId,
      "qa.check_passed",
      buildQaPassedPayload({ ...base, artifactPath: screenshotPath }),
    );
  } else {
    await appendThreadEvent(
      threadId,
      "qa.check_failed",
      buildQaFailedPayload({
        ...base,
        failures: [
          {
            type: "visual_verdict",
            detail: `layout=${verdict.layout} blank=${verdict.blank} misalignment=${verdict.misalignment} | ${verdict.summary}`,
            artifactPath: screenshotPath,
          },
        ],
      }),
    );
  }
}

/** 构造 QA 工具集（注入 threadId + runtime + runtimeType）。 */
export function buildQaTools(
  threadId: string,
  runtime: RuntimeHandle,
  _runtimeType: RuntimeType | undefined,
) {
  const { preview } = runtime;
  void _runtimeType;

  return {
    capturePreview: tool({
      description:
        "对当前会话预览截图（Playwright 驱动）。默认 desktop viewport；可指定宽度。" +
        "截图落 artifact，供自检与 Studio 查看。reportReady 的 QA gate 会自动跑浏览器检查，本工具供你提前自检。",
      inputSchema: z.object({
        viewport: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("视口宽度（像素），如 375/768/1280；不传用 desktop 默认"),
      }),
      execute: async ({ viewport }) => {
        try {
          return await executeToolRun(threadId, "capturePreview", { viewport }, async (signal) => {
            const { url, token, kind } = await preview.start(threadId);
            const checkId = `capture-${randomUUID().slice(0, 8)}`;
            const result = await capturePreviewUrl({
              url,
              previewToken: kind === "static" ? token : undefined,
              threadId,
              checkId,
              viewport,
            });
            await emitCaptureEvent(threadId, checkId, result);
            return result;
          });
        } catch (error) {
          return { ok: false, error: errMsg(error) } as unknown as CaptureResult;
        }
      },
    }),

    runBrowserCheck: tool({
      description:
        "对当前会话预览跑确定性浏览器检查：console error / 未捕获异常 / network 404 / 白屏。" +
        "默认三档 viewport(375/768/1280)。任一失败 → ok:false 并列出 failures。证据落 artifact。" +
        "console warning 不阻断；404 白名单(favicon/fonts)不误杀。reportReady 的 QA gate 即本检查的子集。",
      inputSchema: z.object({
        viewports: z
          .array(z.number().int().positive())
          .optional()
          .describe("视口宽度列表，不传用 QA_VIEWPORTS 默认 375/768/1280"),
      }),
      execute: async ({ viewports }) => {
        try {
          return await executeToolRun(
            threadId,
            "runBrowserCheck",
            { viewports },
            async (signal) => {
              const { url, token, kind } = await preview.start(threadId);
              const checkId = `browser-${randomUUID().slice(0, 8)}`;
              const result = await runBrowserCheckUrl({
                url,
                previewToken: kind === "static" ? token : undefined,
                threadId,
                checkId,
                viewports,
              });
              await emitBrowserCheckEvent(threadId, checkId, "browser", result);
              return result;
            },
          );
        } catch (error) {
          return { ok: false, error: errMsg(error) } as unknown as BrowserCheckResult;
        }
      },
    }),

    runResponsiveCheck: tool({
      description:
        "对当前会话预览跑响应式布局断言（375/768/1280 三档）：水平溢出 / 内容不可见 / 响应式破坏（移动端未堆叠）。" +
        "确定性规则，不做像素 diff。证据（三档截图 + 断言 JSON）落 artifact。",
      inputSchema: z.object({
        viewports: z
          .array(z.number().int().positive())
          .optional()
          .describe("视口宽度列表，不传用 QA_VIEWPORTS 默认 375/768/1280"),
      }),
      execute: async ({ viewports }) => {
        try {
          return await executeToolRun(
            threadId,
            "runResponsiveCheck",
            { viewports },
            async (signal) => {
              const { url, token, kind } = await preview.start(threadId);
              const checkId = `responsive-${randomUUID().slice(0, 8)}`;
              const result = await runResponsiveCheckUrl({
                url,
                previewToken: kind === "static" ? token : undefined,
                threadId,
                checkId,
                viewports,
              });
              await emitResponsiveEvent(threadId, checkId, result);
              return result;
            },
          );
        } catch (error) {
          return { ok: false, error: errMsg(error) } as unknown as ResponsiveResult;
        }
      },
    }),

    runAccessibilitySmoke: tool({
      description:
        "对当前会话预览跑 a11y 烟雾检查：img alt / 表单 label / 对比度(简化) / Tab 顺序 / landmark。" +
        "烟雾级，非完整 axe 审计。违规列表 + 截图落 artifact。",
      inputSchema: z.object({
        viewport: z.number().int().positive().optional().describe("视口宽度，不传用 desktop 默认"),
      }),
      execute: async ({ viewport }) => {
        try {
          return await executeToolRun(
            threadId,
            "runAccessibilitySmoke",
            { viewport },
            async (signal) => {
              const { url, token, kind } = await preview.start(threadId);
              const checkId = `a11y-${randomUUID().slice(0, 8)}`;
              const result = await runAccessibilitySmokeUrl({
                url,
                previewToken: kind === "static" ? token : undefined,
                threadId,
                checkId,
                viewport,
              });
              await emitA11yEvent(threadId, checkId, result);
              return result;
            },
          );
        } catch (error) {
          return { ok: false, error: errMsg(error) } as unknown as A11yResult;
        }
      },
    }),

    visualVerdict: tool({
      description:
        "对一张已有截图（capturePreview 返回的 screenshotPath）做结构化视觉评审（可选 LLM）。" +
        "输出 layout/blank/misalignment/summary。无 LLM 配置时退化为确定性基础判断。" +
        "agent 自检工具，reportReady 的 QA gate **不依赖**本工具。",
      inputSchema: z.object({
        screenshotPath: z.string().describe("capturePreview 返回的 screenshotPath（相对路径）"),
        prompt: z.string().optional().describe("自定义评审指令，不传用默认"),
      }),
      execute: async ({ screenshotPath, prompt }) => {
        try {
          return await executeToolRun(
            threadId,
            "visualVerdict",
            { screenshotPath, prompt },
            async (signal) => {
              const checkId = `verdict-${randomUUID().slice(0, 8)}`;
              const verdict = await visualVerdict({ threadId, screenshotPath, prompt });
              await emitVerdictEvent(threadId, checkId, screenshotPath, verdict);
              return verdict;
            },
          );
        } catch (error) {
          return { ok: false, error: errMsg(error) } as unknown as VisualVerdict & {
            ok: boolean;
          };
        }
      },
    }),
  };
}
