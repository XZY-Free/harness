import type { UIMessage } from "ai";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 生成 v4 UUID（密码学安全，Node 20+/浏览器通用）。 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * D-3: 格式化消息时间戳。
 * - < 1min → 「刚刚」
 * - < 1h → 「X 分钟前」
 * - 今天 → 「HH:mm」
 * - 更早 → 「MM/DD HH:mm」
 * 无时间戳（内存态新消息）返回空串，调用方据此不渲染。
 */
export function formatMessageTime(date?: Date | string | number): string {
  if (!date) return "";
  const dateObj = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  if (!dateObj || Number.isNaN(dateObj.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  if (diffMs < 60_000) return "刚刚";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  const sameDay =
    now.getFullYear() === dateObj.getFullYear() &&
    now.getMonth() === dateObj.getMonth() &&
    now.getDate() === dateObj.getDate();
  const hh = String(dateObj.getHours()).padStart(2, "0");
  const mm = String(dateObj.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const M = String(dateObj.getMonth() + 1).padStart(2, "0");
  const D = String(dateObj.getDate()).padStart(2, "0");
  return `${M}/${D} ${hh}:${mm}`;
}

/** 从一条消息里拼出纯文本内容（取所有 text part）。 */
export function getTextFromMessage(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

/**
 * P2-2: 转义 SQL LIKE 通配符(% _ \),防用户搜索 "%" 匹配全部行 / "_" 匹配单字符
 * 探测数据形状并触发全表扫描。转义后需配合 LIKE ... ESCAPE '\\' 使用,或 Drizzle like()
 * 默认转义符为 \\。
 */
export function escapeLikeWildcards(input: string): string {
  return input.replace(/[%_\\]/g, "\\$&");
}
