/**
 * ：命令定义和校验。
 *
 * 仅允许读取类命令。追加操作类命令和更多读取类命令。
 * 每个命令都有对应的 payload schema，用于校验 RPC 请求的 payload 字段。
 *
 * 安全约束：
 * - 命令白名单严格匹配，未知命令一律拒绝
 * - payload 必须通过 schema 校验，防止注入非法参数
 * - 操作类命令需要 approval（见 approval.ts）
 * - 命令名使用 V10 dotted 格式（browser.getTabs），与 AI 工具名（browserGetTabs）映射
 */
import { z } from "zod";

/**
 * 读取类命令（不修改浏览器状态）。
 */
export const READ_COMMANDS = [
 "browser.getTabs",
 "browser.getPageMetadata",
 "browser.screenshot",
 "browser.snapshot",
 "browser.getAccessibilityTree",
 "browser.getConsole",
 "browser.getNetwork",
 "browser.listDownloads",
] as const;

export type ReadCommand = (typeof READ_COMMANDS)[number];

/**
 * 操作类命令（修改浏览器状态，需要 approval）。
 */
export const ACTION_COMMANDS = [
 "browser.navigate",
 "browser.click",
 "browser.doubleClick",
 "browser.type",
 "browser.press",
 "browser.select",
 "browser.scroll",
 "browser.newTab",
 "browser.closeTab",
 "browser.switchTab",
 "browser.reload",
 "browser.goBack",
 "browser.goForward",
 "browser.uploadWorkspaceFile",
] as const;

export type ActionCommand = (typeof ACTION_COMMANDS)[number];

/**
 * 所有允许的命令（读取类 + 操作类）。
 */
export const ALLOWED_COMMANDS = [...READ_COMMANDS, ...ACTION_COMMANDS] as const;

export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

/**
 * V9 工具名 → V10 RPC 命令名映射。
 *
 * AI 面向的工具名保持 V9 camelCase（browserGetTabs），
 * RPC 线路使用 V10 dotted 格式（browser.getTabs）。
 */
export const TOOL_TO_COMMAND: Record<string, AllowedCommand> = {
 browserGetTabs: "browser.getTabs",
 browserSnapshot: "browser.snapshot",
 browserGetConsole: "browser.getConsole",
 browserGetNetwork: "browser.getNetwork",
 browserScreenshot: "browser.screenshot",
 browserGetPageText: "browser.getPageMetadata",
 browserNavigate: "browser.navigate",
 browserClick: "browser.click",
 browserType: "browser.type",
 browserScroll: "browser.scroll",
 browserPressKey: "browser.press",
 browserSelectOption: "browser.select",
 browserUploadFile: "browser.uploadWorkspaceFile",
 browserListDownloads: "browser.listDownloads",
};

/**
 * V10 RPC 命令名 → V9 工具名反向映射。
 */
export const COMMAND_TO_TOOL: Record<AllowedCommand, string> = Object.fromEntries(
 Object.entries(TOOL_TO_COMMAND).map(([tool, cmd]) => [cmd, tool]),
) as Record<AllowedCommand, string>;

/**
 * 命令的 payload schema。
 */
export const commandPayloadSchemas: Record<AllowedCommand, z.ZodType> = {
 // ── 读取类 ──
 "browser.getTabs": z.object({ threadId: z.string().min(1) }),
 "browser.getPageMetadata": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 }),
 "browser.screenshot": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 format: z.enum(["png", "jpeg"]).default("png"),
 }),
 "browser.snapshot": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 maxTextLength: z.number().int().positive().max(10000).optional(),
 }),
 "browser.getAccessibilityTree": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 }),
 "browser.getConsole": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 level: z.enum(["error", "warning+"]).optional(),
 limit: z.number().int().positive().max(200).optional(),
 }),
 "browser.getNetwork": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 filter: z.enum(["failed", "slow"]).optional(),
 limit: z.number().int().positive().max(200).optional(),
 }),
 "browser.listDownloads": z.object({ threadId: z.string().min(1) }),

 // ── 操作类 ──
 "browser.navigate": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 url: z.string().min(1),
 }),
 "browser.click": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 x: z.number(),
 y: z.number(),
 button: z.enum(["left", "right", "middle"]).optional(),
 description: z.string().optional(),
 }),
 "browser.doubleClick": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 x: z.number(),
 y: z.number(),
 description: z.string().optional(),
 }),
 "browser.type": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 text: z.string(),
 selector: z.string().optional(),
 }),
 "browser.press": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 key: z.string().min(1),
 }),
 "browser.select": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 selector: z.string().min(1),
 value: z.string().optional(),
 label: z.string().optional(),
 }),
 "browser.scroll": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 deltaX: z.number(),
 deltaY: z.number(),
 }),
 "browser.newTab": z.object({
 threadId: z.string().min(1),
 url: z.string().min(1),
 }),
 "browser.closeTab": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 }),
 "browser.switchTab": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 }),
 "browser.reload": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 }),
 "browser.goBack": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 }),
 "browser.goForward": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 }),
 "browser.uploadWorkspaceFile": z.object({
 threadId: z.string().min(1),
 tabId: z.string().min(1),
 selector: z.string().min(1),
 downloadUrl: z.string().min(1),
 }),
};

/**
 * 判断命令是否在允许列表中。
 */
export function isAllowedCommand(command: string): command is AllowedCommand {
 return (ALLOWED_COMMANDS as readonly string[]).includes(command);
}

/**
 * 判断命令是否为读取类。
 */
export function isReadCommand(command: string): command is ReadCommand {
 return (READ_COMMANDS as readonly string[]).includes(command);
}

/**
 * 判断命令是否为操作类。
 */
export function isActionCommand(command: string): command is ActionCommand {
 return (ACTION_COMMANDS as readonly string[]).includes(command);
}

/**
 * 将 V9 工具名映射为 V10 RPC 命令名。
 */
export function toolToCommand(toolName: string): AllowedCommand | null {
 return TOOL_TO_COMMAND[toolName] ?? null;
}

/**
 * 校验命令的 payload。
 */
export function validateCommandPayload(
 command: string,
 payload: unknown,
): { ok: true; payload: unknown } | { ok: false; error: string } {
 if (!isAllowedCommand(command)) {
 return { ok: false, error: "unknown_command" };
 }
 const schema = commandPayloadSchemas[command];
 const result = schema.safeParse(payload);
 if (!result.success) {
 return { ok: false, error: "invalid_payload" };
 }
 return { ok: true, payload: result.data };
}
