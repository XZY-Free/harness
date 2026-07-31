/**
 * V10 Phase 4：导航操作命令。
 *
 * 定义用户和 AI 可发送的浏览器导航命令。
 * 纯函数校验命令参数，不依赖 electron。
 */

/** 导航命令类型 */
export type NavActionType = "navigate" | "back" | "forward" | "reload" | "stop";

/** 导航命令基础结构 */
export interface NavAction {
  type: NavActionType;
  threadId: string;
  tabId: string;
}

/** navigate 命令带 URL */
export interface NavigateAction extends NavAction {
  type: "navigate";
  url: string;
}

/** 其他命令不需要额外参数 */
export type BackAction = NavAction & { type: "back" };
export type ForwardAction = NavAction & { type: "forward" };
export type ReloadAction = NavAction & { type: "reload" };
export type StopAction = NavAction & { type: "stop" };

/** 所有导航命令 */
export type BrowserNavAction =
  | NavigateAction
  | BackAction
  | ForwardAction
  | ReloadAction
  | StopAction;

/** 命令校验结果 */
export interface NavActionResult {
  ok: boolean;
  action?: BrowserNavAction;
  error?: string;
}

/** URL 最大长度（防止超长 URL 攻击） */
export const MAX_URL_LENGTH = 8192;

/**
 * 校验 URL 是否为有效的 http/https URL。
 *
 * WebContentsView 只允许 http/https 导航。
 * file/data/blob/javascript 等协议被阻止。
 */
export function isValidNavUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (url.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 校验并规范化 navigate 命令。
 *
 * @param raw - 原始输入
 * @returns 校验通过返回 action，否则返回 error
 */
export function validateNavAction(raw: unknown): NavActionResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "命令必须是对象" };
  }

  const obj = raw as Record<string, unknown>;
  const { type, threadId, tabId } = obj;

  // 校验 type
  if (typeof type !== "string") {
    return { ok: false, error: "type 必须是字符串" };
  }
  const validTypes = ["navigate", "back", "forward", "reload", "stop"];
  if (!validTypes.includes(type)) {
    return { ok: false, error: `type 必须是 ${validTypes.join("/")} 之一` };
  }

  // 校验 threadId
  if (typeof threadId !== "string" || threadId.length === 0) {
    return { ok: false, error: "threadId 必须是非空字符串" };
  }

  // 校验 tabId
  if (typeof tabId !== "string" || tabId.length === 0) {
    return { ok: false, error: "tabId 必须是非空字符串" };
  }

  // navigate 命令需要额外校验 URL
  if (type === "navigate") {
    if (!isValidNavUrl(obj.url)) {
      return { ok: false, error: "navigate 命令需要有效的 http/https URL" };
    }
    return {
      ok: true,
      action: { type: "navigate", threadId, tabId, url: obj.url as string },
    };
  }

  // 其他命令
  return {
    ok: true,
    action: { type: type as "back" | "forward" | "reload" | "stop", threadId, tabId },
  };
}

/**
 * 标准化 URL（补全 protocol、去除空白）。
 *
 * 用户在地址栏输入 "example.com" → "https://example.com"
 * 输入 "http://example.com" → 保持不变
 *
 * @param input - 用户输入
 * @returns 标准化后的 URL，或 null（无法标准化）
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // 已有协议
  if (/^https?:\/\//i.test(trimmed)) {
    return isValidNavUrl(trimmed) ? trimmed : null;
  }

  // 无协议，补全 https://
  const withProtocol = `https://${trimmed}`;
  return isValidNavUrl(withProtocol) ? withProtocol : null;
}
