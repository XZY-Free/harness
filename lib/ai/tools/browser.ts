/**
 * V10 Phase 6：AI 浏览器工具（执行器迁移到 Desktop RPC）。
 *
 * 背景：V10 删除服务器远程浏览器链路（browserGateway / page-insights /
 * browser-queries / browser-policy / workspace 浏览器相关调用全部移除）。
 * Web 端不再提供内置浏览器，浏览器工具改由 macOS Desktop 客户端本地驱动。
 *
 * Phase 6 变更：执行器从 desktopUnavailable() 占位迁移到真正的 Desktop RPC 调用。
 * - 13 个工具（browserGetTabs/Snapshot/GetConsole/GetNetwork/Screenshot/GetPageText/
 *   Navigate/Click/Type/Scroll/PressKey/SelectOption/UploadFile）通过 executeBrowserToolRpc
 *   路由到 Desktop 执行
 *
 * Phase 7-1 变更：browserListDownloads 从 desktopUnavailable 迁移到 Desktop RPC，
 * 经 browser.listDownloads 命令读取 DownloadManager 中的下载记录。
 *
 * executeBrowserToolRpc 完整流程：
 * 1. toolName → RPC command 映射（commands.ts TOOL_TO_COMMAND）
 * 2. 构建 RPC payload（threadId + 工具 input 字段映射）
 * 3. approval 校验（approval.ts decideApproval：deny/require_approval/allow）
 * 4. tabId 解析（需要 tabId 的命令先调 browser.getTabs 获取 active tab）
 * 5. RPC 发送（BridgeServer.sendRpcToThread → routeRpc → lease holder 设备）
 * 6. 结果脱敏（redaction.ts redactCommandResult：Desktop 已脱敏，Server 再脱敏防绕过）
 * 7. runId 注入（getThreadRunScope 获取当前 ThreadRun ID，注入 RPC 信封）
 *
 * executeToolRun 审计包装保留：每次调用仍落 tool_runs + tool.called /
 * tool.succeeded / tool.failed 事件。
 *
 * 工具分两类（schema 保留原 risk 分类，供权限引擎与限流使用）：
 * - 读取类（risk: read）：browserGetTabs / browserSnapshot / browserGetConsole /
 *   browserGetNetwork / browserScreenshot / browserGetPageText / browserListDownloads
 * - 操作类（risk: execute）：browserNavigate / browserClick / browserType /
 *   browserScroll / browserPressKey / browserSelectOption / browserUploadFile
 */

import { executeToolRun } from "@/lib/ai/tool-runtime";
import { type BrowserToolResult, executeBrowserToolRpc } from "@/lib/ai/tools/browser-rpc-client";
import { getBridgeServer } from "@/lib/desktop-bridge/bridge-server";
import { tool } from "ai";
import { z } from "zod";

// ─── 辅助 ──────────────────────────────────────────────────────

/**
 * desktop_unavailable 统一返回结构。
 *
 * Bridge 未启动（开发/测试环境）或 Phase 7 未实现工具时返回。
 */
function desktopUnavailable() {
  return {
    ok: false as const,
    error: "desktop_unavailable",
    message:
      "Browser 工具当前不可用:Web 端已不再提供内置浏览器。请在 macOS Desktop 客户端中打开此 Thread 以使用浏览器工具。",
  };
}

/**
 * 通过 Desktop RPC 执行浏览器工具。
 *
 * 内部流程：获取 BridgeServer 单例 → 调用 executeBrowserToolRpc → 返回结果。
 * Bridge 未启动时返回 desktop_unavailable（开发/测试环境降级）。
 *
 * @param threadId thread ID
 * @param toolName V9 工具名（如 browserGetTabs）
 * @param input 工具输入参数
 * @returns RPC 执行结果或 desktop_unavailable
 */
async function runBrowserViaRpc(
  threadId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<BrowserToolResult> {
  const server = getBridgeServer();
  if (!server) {
    return desktopUnavailable();
  }
  return executeBrowserToolRpc({
    dispatcher: server,
    threadId,
    toolName,
    input,
  });
}

// ─── 工具工厂 ──────────────────────────────────────────────────

export function buildBrowserTools(threadId: string) {
  return {
    // ═══ 读取类工具 ═══

    /** 列出当前 Thread 浏览器的全部 tab 状态。 */
    browserGetTabs: tool({
      description:
        "列出当前 Thread 内置浏览器的全部标签页状态（id、标题、URL、加载状态）。用于了解当前打开了哪些页面。",
      inputSchema: z.object({}),
      execute: async () =>
        executeToolRun(threadId, "browserGetTabs", {}, async () =>
          runBrowserViaRpc(threadId, "browserGetTabs", {}),
        ),
    }),

    /** 返回当前页面的可见文本、DOM 摘要和 accessibility tree。 */
    browserSnapshot: tool({
      description:
        "获取当前 active tab 的页面快照：页面标题、可见文本（前 2000 字符）、accessibility tree 摘要、表单值、按钮/链接列表。用于了解页面内容和交互结构。",
      inputSchema: z.object({
        maxTextLength: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("可见文本最大字符数，默认 2000"),
      }),
      execute: async ({ maxTextLength }) =>
        executeToolRun(threadId, "browserSnapshot", { maxTextLength }, async () =>
          runBrowserViaRpc(threadId, "browserSnapshot", { maxTextLength }),
        ),
    }),

    /** 返回 console error/warning 摘要。 */
    browserGetConsole: tool({
      description:
        "获取当前 active tab 的 console 消息（error、warning、pageerror）。用于调试页面 JS 错误。level=error 只返回错误，level=warning+ 返回警告和错误。",
      inputSchema: z.object({
        level: z
          .enum(["error", "warning+"])
          .optional()
          .describe("过滤级别：error=只返回错误，warning+=返回警告+错误。默认 error"),
        limit: z.number().int().positive().max(200).optional().describe("最大条目数，默认 50"),
      }),
      execute: async ({ level, limit }) =>
        executeToolRun(threadId, "browserGetConsole", { level, limit }, async () =>
          runBrowserViaRpc(threadId, "browserGetConsole", { level, limit }),
        ),
    }),

    /** 返回失败请求和慢请求摘要。 */
    browserGetNetwork: tool({
      description:
        "获取当前 active tab 的网络请求摘要。filter=failed 只返回失败请求（404/500/DNS错误），filter=slow 只返回慢请求（>3s），默认返回全部。",
      inputSchema: z.object({
        filter: z
          .enum(["failed", "slow"])
          .optional()
          .describe("过滤：failed=失败请求，slow=慢请求。默认返回全部"),
        limit: z.number().int().positive().max(200).optional().describe("最大条目数，默认 50"),
      }),
      execute: async ({ filter, limit }) =>
        executeToolRun(threadId, "browserGetNetwork", { filter, limit }, async () =>
          runBrowserViaRpc(threadId, "browserGetNetwork", { filter, limit }),
        ),
    }),

    /** 截图当前页面，落 artifact 文件，返回路径 + base64（供 AI 视觉调试）。 */
    browserScreenshot: tool({
      description:
        "对当前 active tab 截图（PNG），保存到 Thread 工作区 artifacts/browser-screenshots/ 目录，返回文件路径和 base64 数据。base64 可供视觉模型直接分析页面布局和元素位置，用于视觉调试。",
      inputSchema: z.object({
        fullPage: z
          .boolean()
          .optional()
          .describe("是否截取完整页面（含滚动区域），默认 false 只截 viewport"),
      }),
      execute: async ({ fullPage }) =>
        executeToolRun(threadId, "browserScreenshot", { fullPage }, async () =>
          runBrowserViaRpc(threadId, "browserScreenshot", { fullPage }),
        ),
    }),

    /** 获取当前页面的纯文本内容（比 snapshot 更轻量，不带 a11y tree）。 */
    browserGetPageText: tool({
      description:
        "获取当前 active tab 的页面纯文本内容。比 browserSnapshot 轻量，不包含 accessibility tree，适合快速了解页面文字。",
      inputSchema: z.object({
        maxTextLength: z.number().int().positive().optional().describe("最大字符数，默认 5000"),
      }),
      execute: async ({ maxTextLength }) =>
        executeToolRun(threadId, "browserGetPageText", { maxTextLength }, async () =>
          runBrowserViaRpc(threadId, "browserGetPageText", { maxTextLength }),
        ),
    }),

    // ═══ 操作类工具 ═══

    /** 导航 active tab 到指定 URL。 */
    browserNavigate: tool({
      description: "在内置浏览器中导航 active tab 到指定 URL。",
      inputSchema: z.object({
        url: z.string().describe("目标 URL（需含协议，如 https://example.com）"),
      }),
      execute: async ({ url }) =>
        executeToolRun(threadId, "browserNavigate", { url }, async () =>
          runBrowserViaRpc(threadId, "browserNavigate", { url }),
        ),
    }),

    /** 在页面上点击指定坐标。 */
    browserClick: tool({
      description:
        "在当前 active tab 的页面上点击指定坐标。坐标基于浏览器视口（viewport），左上角为 (0,0)。建议通过 description 描述点击意图，含敏感动作（删除/提交/付款等）时将要求用户确认。",
      inputSchema: z.object({
        x: z.number().describe("X 坐标（viewport 坐标系）"),
        y: z.number().describe("Y 坐标（viewport 坐标系）"),
        button: z.enum(["left", "right", "middle"]).optional().describe("鼠标按钮，默认 left"),
        description: z
          .string()
          .optional()
          .describe("点击意图描述（如「点击删除按钮」「提交表单」），用于风险判定"),
      }),
      execute: async ({ x, y, button, description }) =>
        executeToolRun(threadId, "browserClick", { x, y, button, description }, async () =>
          runBrowserViaRpc(threadId, "browserClick", { x, y, button, description }),
        ),
    }),

    /** 在页面上输入文本（聚焦到当前元素）。 */
    browserType: tool({
      description:
        "在当前 active tab 中输入文本（模拟键盘逐字输入）。若提供 selector，先聚焦该元素再输入；否则输入到当前聚焦元素。",
      inputSchema: z.object({
        text: z.string().describe("要输入的文本"),
        selector: z
          .string()
          .optional()
          .describe(
            "可选 CSS selector。提供后先 focus 该元素再 type，避免焦点不在 input 上导致文本丢失。",
          ),
      }),
      execute: async ({ text, selector }) =>
        executeToolRun(threadId, "browserType", { text, selector }, async () =>
          runBrowserViaRpc(threadId, "browserType", { text, selector }),
        ),
    }),

    /** 滚动页面。 */
    browserScroll: tool({
      description: "在当前 active tab 中滚动页面（鼠标滚轮）。",
      inputSchema: z.object({
        deltaX: z.number().describe("水平滚动量（正=向右）"),
        deltaY: z.number().describe("垂直滚动量（正=向下）"),
      }),
      execute: async ({ deltaX, deltaY }) =>
        executeToolRun(threadId, "browserScroll", { deltaX, deltaY }, async () =>
          runBrowserViaRpc(threadId, "browserScroll", { deltaX, deltaY }),
        ),
    }),

    /** 按键（如 Enter / Escape / Tab / ArrowDown）。 */
    browserPressKey: tool({
      description:
        "在当前 active tab 中按下键盘按键。支持组合键（如 Control+a / Shift+Enter）。参考 Playwright key code。",
      inputSchema: z.object({
        key: z
          .string()
          .describe("Playwright 按键代码，如 Enter / Escape / Tab / ArrowDown / Control+a"),
      }),
      execute: async ({ key }) =>
        executeToolRun(threadId, "browserPressKey", { key }, async () =>
          runBrowserViaRpc(threadId, "browserPressKey", { key }),
        ),
    }),

    /** 选择下拉框选项（select element）。 */
    browserSelectOption: tool({
      description:
        "在当前 active tab 中选择 select 元素的选项。通过 CSS selector 定位 select 元素，选择匹配 value 或 label 的 option。",
      inputSchema: z.object({
        selector: z
          .string()
          .describe("select 元素的 CSS selector，如 #country 或 select[name='lang']"),
        value: z.string().optional().describe("option 的 value 属性"),
        label: z.string().optional().describe("option 的显示文本（与 value 二选一）"),
      }),
      execute: async ({ selector, value, label }) =>
        executeToolRun(threadId, "browserSelectOption", { selector, value, label }, async () =>
          runBrowserViaRpc(threadId, "browserSelectOption", { selector, value, label }),
        ),
    }),

    // ═══ V9 阶段 8：下载与上传工具 ═══

    /** 列出当前 Thread 的浏览器下载记录（只读）。 */
    browserListDownloads: tool({
      description:
        "列出当前 Thread 内置浏览器的下载记录（id、文件名、状态、大小、来源 URL、工作区路径）。只读，用于了解有哪些文件已下载到工作区 downloads/ 目录。本工具不触发下载，仅查询已有记录。",
      inputSchema: z.object({}),
      execute: async () =>
        executeToolRun(threadId, "browserListDownloads", {}, async () =>
          runBrowserViaRpc(threadId, "browserListDownloads", {}),
        ),
    }),

    /** 上传 Thread 工作区文件到当前页面的 file input 元素。 */
    browserUploadFile: tool({
      description:
        "在当前 active tab 中上传 Thread 工作区文件到页面 file input 元素。只能上传工作区内文件（路径相对工作区根，不允许 .. 越界）。AI 不能指定本机任意路径，由 Server 签发一次性下载凭证，Desktop 下载到临时目录后交给 WebContents。用于表单文件上传场景。",
      inputSchema: z.object({
        selector: z
          .string()
          .describe("file input 元素的 CSS selector，如 input[type='file'] 或 #upload"),
        workspacePath: z
          .string()
          .describe(
            "工作区内文件的相对路径（如 uploads/image.png 或 downloads/report.pdf），不允许 .. 越界",
          ),
      }),
      execute: async ({ selector, workspacePath }) =>
        executeToolRun(threadId, "browserUploadFile", { selector, workspacePath }, async () =>
          runBrowserViaRpc(threadId, "browserUploadFile", { selector, workspacePath }),
        ),
    }),
  };
}
