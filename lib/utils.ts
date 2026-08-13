import type { DBMessage } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
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

/** 不应在 UI 上展示的内部 part 类型（AI SDK 流式控制用）。 */
const INTERNAL_PART_TYPES = new Set(["step-start", "step-complete"]);

/** DB 行 → 前端 UIMessage（parts 在库里以 json 存储，过滤内部类型）。 */
export function convertToUIMessages(messages: DBMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant" | "system",
    parts: (m.parts as ChatMessage["parts"])
      .filter((p) => !INTERNAL_PART_TYPES.has(p.type))
      .map((p) => repairOrphanToolCall(p)),
    createdAt: m.createdAt, // D-3: 带出 DB 创建时间供消息时间戳展示
  }));
}

/**
 * 修复孤儿 tool call。执行中断（dev 崩溃 / 进程退出 / run 超时被 reap）会留下
 * state=input-available 的 tool call——已发起但 result 未落库。AI SDK 的
 * convertToModelMessages 遇到无 result 的 tool call 会抛
 * "Tool result is missing for tool call <id>"，导致该 thread 后续所有消息发不出去。
 *
 * 给孤儿补一个错误 output（state→output-available），让 LLM 知道工具被中断可继续，
 * 同时打通历史链路。幂等：output-available 的 part 原样返回。
 */
function repairOrphanToolCall<P extends ChatMessage["parts"][number]>(part: P): P {
  const p = part as unknown as {
    type?: string;
    toolCallId?: string;
    state?: string;
  };
  if (
    typeof p.type === "string" &&
    p.type.startsWith("tool-") &&
    p.toolCallId &&
    p.state !== "output-available"
  ) {
    return {
      ...p,
      state: "output-available",
      output: { error: "执行已中断" },
      isError: true,
    } as unknown as P;
  }
  return part;
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
