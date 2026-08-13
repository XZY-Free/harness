/**
 * ：Server 端 Browser RPC client。
 *
 * 将 AI 浏览器工具的执行从 desktopUnavailable() 占位迁移到真正的 Desktop RPC 调用。
 * 完整流程：toolName → command 映射 → payload 构建 → approval 校验 → tabId 解析 →
 * RPC 路由发送 → 结果脱敏。
 *
 * 设计要点：
 * - 纯逻辑模块，不直接依赖 BridgeServer 实例（通过 BrowserRpcDispatcher 接口解耦）
 * - approve 校验在 Server 端先执行一道（deny → 拒绝，require_approval → 需 approvalId）
 * - Desktop 端会再次校验 approval scope（防绕过，实现）
 * - 结果经 redactCommandResult 二次脱敏（Desktop 已脱敏一次，Server 再脱敏防绕过）
 * - runId 从 getThreadRunScope 获取，注入 RPC 信封做 ToolRun 归属
 *
 * 安全约束：
 * - credential 风险一律拒绝（AI 不得代填密码，用户必须手动输入）
 * - external_write / destructive / financial 必须携带有效 approvalId
 * - 截图原始字节不传回 Server（Desktop 只传引用路径，Server 脱敏替换为 ref 占位）
 * - Cookie / token / Authorization 不出现在 RPC 结果中（sanitizeHeaders 移除）
 */

import { getCurrentToolApprovalId, getThreadRunScope } from "@/lib/ai/tool-runtime";
import { getApprovalRequest, getThreadById } from "@/lib/db/queries";
import { decideApproval } from "@/lib/desktop/approval";
import { toolToCommand } from "@/lib/desktop/commands";
import { redactCommandResult } from "@/lib/desktop/redaction";
import { computeArgFingerprint } from "@/lib/permission/approval";
import { issueUploadToken } from "@/lib/workspace-upload-token";

/**
 * Browser RPC dispatcher 抽象接口。
 *
 * BridgeServer 实现 sendRpcToThread 方法满足此接口。
 * 解耦后 browser-rpc-client 可在 vitest 中用 mock dispatcher 测试。
 */
export interface BrowserRpcDispatcher {
  sendRpcToThread(params: {
    threadId: string;
    userId: string;
    command: string;
    payload: unknown;
    runId?: string | null;
    approvalId?: string | null;
  }): Promise<{ ok: boolean; result?: unknown; code?: string; message?: string }>;
}

/**
 * 浏览器工具执行结果。
 */
export interface BrowserToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
  message?: string;
}

/**
 * 需要 tabId 的命令集合（操作对象为 active tab，工具 input 不含 tabId）。
 *
 * browser.getTabs 和 browser.newTab 不需要 tabId（列出/创建而非操作指定 tab）。
 */
const COMMANDS_NEEDING_TAB_ID = new Set<string>([
  "browser.getPageMetadata",
  "browser.screenshot",
  "browser.snapshot",
  "browser.getAccessibilityTree",
  "browser.getConsole",
  "browser.getNetwork",
  "browser.navigate",
  "browser.click",
  "browser.doubleClick",
  "browser.type",
  "browser.press",
  "browser.select",
  "browser.scroll",
  "browser.closeTab",
  "browser.switchTab",
  "browser.reload",
  "browser.goBack",
  "browser.goForward",
  "browser.uploadWorkspaceFile",
]);

/**
 * 获取 Server origin，用于构造 downloadUrl。
 *
 * 优先读 SNOW_SERVER_ORIGIN 环境变量（与 Desktop origin-guard 一致），
 * 缺失时回退到 http://localhost:3000（本地开发默认）。
 *
 * browser-rpc-client 不在 request 上下文中，无法从 host header 推断 origin，
 * 必须从 env 读取。生产部署时通过环境变量注入。
 */
function getServerOrigin(): string {
  const raw = process.env.SNOW_SERVER_ORIGIN;
  if (raw && raw.trim().length > 0) {
    return raw.trim();
  }
  return "http://localhost:3000";
}

/**
 * 从工具 input 构建 RPC payload。
 *
 * 工具 input 使用 V9 camelCase 字段名（如 maxTextLength、fullPage），
 * RPC payload 使用 V10 字段名（与 commandPayloadSchemas 一致）。
 * threadId 由调用方注入（工具层持有 threadId）。
 *
 * browser.uploadWorkspaceFile 特殊处理（）：
 * - 工具 input 携带 workspacePath（workspace 内相对路径）
 * - Server 在 buildRpcPayload 中签发一次性下载凭证（token）
 * - 构造 downloadUrl 放入 payload（替代原来的 filePath）
 * - Desktop 收到后通过 HTTP GET 下载到临时目录，再交给 CDP
 * - AI 不能指定本机任意路径，确保安全
 */
function buildRpcPayload(
  command: string,
  input: Record<string, unknown>,
  threadId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { threadId };

  switch (command) {
    case "browser.getTabs":
      // 无额外字段
      break;

    case "browser.snapshot":
    case "browser.getPageMetadata":
      if (input.maxTextLength !== undefined) payload.maxTextLength = input.maxTextLength;
      break;

    case "browser.getConsole":
      if (input.level !== undefined) payload.level = input.level;
      if (input.limit !== undefined) payload.limit = input.limit;
      break;

    case "browser.getNetwork":
      if (input.filter !== undefined) payload.filter = input.filter;
      if (input.limit !== undefined) payload.limit = input.limit;
      break;

    case "browser.screenshot":
      // 工具 input: fullPage → Desktop 自行处理，RPC 只传 format
      payload.format = "png";
      break;

    case "browser.navigate":
    case "browser.newTab":
      payload.url = input.url;
      break;

    case "browser.click":
      payload.x = input.x;
      payload.y = input.y;
      if (input.button !== undefined) payload.button = input.button;
      if (input.description !== undefined) payload.description = input.description;
      break;

    case "browser.doubleClick":
      payload.x = input.x;
      payload.y = input.y;
      if (input.description !== undefined) payload.description = input.description;
      break;

    case "browser.type":
      payload.text = input.text;
      if (input.selector !== undefined) payload.selector = input.selector;
      break;

    case "browser.scroll":
      payload.deltaX = input.deltaX;
      payload.deltaY = input.deltaY;
      break;

    case "browser.press":
      payload.key = input.key;
      break;

    case "browser.select":
      payload.selector = input.selector;
      if (input.value !== undefined) payload.value = input.value;
      if (input.label !== undefined) payload.label = input.label;
      break;

    case "browser.uploadWorkspaceFile": {
      payload.selector = input.selector;
      // 兼容 workspacePath（新）与 filePath（旧）字段，最终统一为 workspacePath
      const workspacePath =
        (typeof input.workspacePath === "string" && input.workspacePath) ||
        (typeof input.filePath === "string" && input.filePath) ||
        "";
      // 签发一次性下载凭证（绑定 threadId + workspacePath）
      const token = issueUploadToken(threadId, workspacePath);
      // 构造 downloadUrl，Desktop 通过 HTTP GET 下载到临时目录
      const origin = getServerOrigin();
      payload.downloadUrl = `${origin}/api/threads/${threadId}/workspace/download?token=${token}`;
      break;
    }

    // closeTab / switchTab / reload / goBack / goForward：tabId 由 resolveActiveTabId 注入
    default:
      break;
  }

  return payload;
}

/**
 * 通过 browser.getTabs RPC 解析 thread 的 active tab ID。
 *
 * 对需要 tabId 但工具 input 不含 tabId 的命令，先调 getTabs 获取 active tab。
 * Desktop command-executor 的 getTabs 响应包含 activeTabId 字段。
 */
async function resolveActiveTabId(
  dispatcher: BrowserRpcDispatcher,
  threadId: string,
  userId: string,
  runId: string | null,
): Promise<string | null> {
  const tabsResult = await dispatcher.sendRpcToThread({
    threadId,
    userId,
    command: "browser.getTabs",
    payload: { threadId },
    runId,
    approvalId: null,
  });
  if (!tabsResult.ok || !tabsResult.result) return null;
  const result = tabsResult.result as { activeTabId?: string | null; tabs?: unknown[] };
  // 优先使用 activeTabId
  if (typeof result.activeTabId === "string" && result.activeTabId.length > 0) {
    return result.activeTabId;
  }
  // 降级：使用第一个 tab
  if (Array.isArray(result.tabs) && result.tabs.length > 0) {
    const first = result.tabs[0] as { id?: string };
    if (typeof first?.id === "string") return first.id;
  }
  return null;
}

/**
 * 执行浏览器工具 RPC 调用。
 *
 * 完整流程：
 * 1. toolName → RPC command 映射（未知工具返回 unknown_tool）
 * 2. 构建 RPC payload（threadId + 工具 input 字段映射）
 * 3. approval 校验（deny → 拒绝，require_approval → 需 approvalId，allow → 放行）
 * 4. tabId 解析（需要 tabId 的命令先调 getTabs 获取 active tab）
 * 5. RPC 发送（经 BrowserRpcDispatcher 路由到 lease 持有设备）
 * 6. 结果脱敏（redactCommandResult 二次脱敏防绕过）
 *
 * @param params.dispatcher RPC dispatcher（BridgeServer 实例）
 * @param params.threadId thread ID
 * @param params.toolName V9 工具名（如 browserGetTabs）
 * @param params.input 工具输入参数
 * @param params.userId 用户 ID（未提供时从 threadId 查询）
 * @param params.runId ThreadRun ID（未提供时从 getThreadRunScope 获取）
 * @param params.approvalId approval ID（操作类命令需审批后传入）
 * @returns 执行结果
 */
export async function executeBrowserToolRpc(params: {
  dispatcher: BrowserRpcDispatcher;
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  userId?: string;
  runId?: string | null;
  approvalId?: string | null;
}): Promise<BrowserToolResult> {
  const { dispatcher, threadId, toolName, input } = params;

  // 1. 工具名 → RPC 命令映射
  const command = toolToCommand(toolName);
  if (!command) {
    return {
      ok: false,
      error: "unknown_tool",
      message: `未知浏览器工具：${toolName}（无对应 RPC 命令映射）`,
    };
  }

  // 2. 解析 userId（未提供时从 DB 查询）
  let userId = params.userId;
  if (!userId) {
    const thread = await getThreadById(threadId);
    if (!thread) {
      return {
        ok: false,
        error: "thread_not_found",
        message: `Thread ${threadId} 不存在`,
      };
    }
    userId = thread.userId;
  }

  // 3. 解析 runId（未提供时从 AsyncLocalStorage scope 获取）
  const runId = params.runId !== undefined ? params.runId : getThreadRunScope(threadId);

  // 4. 构建 RPC payload
  const payload = buildRpcPayload(command, input, threadId);
  const contextualApprovalId = getCurrentToolApprovalId();
  const approvalId = params.approvalId ?? contextualApprovalId;

  // 5. approval 校验（Server 端第一道，Desktop 端第二道）
  const decision = decideApproval(command, payload);
  if (decision === "deny") {
    return {
      ok: false,
      error: "credential_denied",
      message: "该操作涉及凭证（密码/验证码），AI 不得代填，请用户手动输入",
    };
  }
  if (decision === "require_approval" && !approvalId) {
    return {
      ok: false,
      error: "approval_required",
      message: `命令 ${command} 风险等级为 ${decideApproval(command, payload)}，需用户审批后携带 approvalId 重试`,
    };
  }
  if (decision === "require_approval" && approvalId && approvalId !== contextualApprovalId) {
    const approval = await getApprovalRequest(approvalId);
    const expectedFingerprint = computeArgFingerprint(toolName, input);
    const valid =
      approval?.status === "approved" &&
      approval.threadId === threadId &&
      approval.toolName === toolName &&
      approval.argFingerprint === expectedFingerprint &&
      (approval.expiresAt === null || approval.expiresAt.getTime() > Date.now());
    if (!valid) {
      return {
        ok: false,
        error: "approval_invalid",
        message: "审批不存在、已过期或与当前浏览器操作不匹配",
      };
    }
  }

  // 6. tabId 解析（需要 tabId 的命令先调 getTabs）
  if (COMMANDS_NEEDING_TAB_ID.has(command)) {
    const tabId = await resolveActiveTabId(dispatcher, threadId, userId, runId);
    if (!tabId) {
      return {
        ok: false,
        error: "no_active_tab",
        message: "Thread 无可用 tab，请先通过 browserNavigate 打开页面",
      };
    }
    payload.tabId = tabId;
  }

  // 7. 发送 RPC
  const rpcResult = await dispatcher.sendRpcToThread({
    threadId,
    userId,
    command,
    payload,
    runId: runId ?? null,
    approvalId: approvalId ?? null,
  });

  if (!rpcResult.ok) {
    return {
      ok: false,
      error: rpcResult.code ?? "rpc_failed",
      code: rpcResult.code,
      message: rpcResult.message ?? "RPC 执行失败",
    };
  }

  // 8. 结果脱敏（Server 端二次脱敏，Desktop 已脱敏一次）
  const redacted = redactCommandResult(command, rpcResult.result);

  return { ok: true, result: redacted };
}
