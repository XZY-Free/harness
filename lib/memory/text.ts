import { createHash } from "node:crypto";

/**
 * memory text 规范化与 hash（纯函数，无 DB 依赖）。
 *
 * 抽出到独立文件以打破 store ↔ index 循环依赖：
 * store.createMemory 触发 index.indexMemory，index 又需要 hashMemoryText。
 * store.ts re-export 本文件的导出，保持既有 `import { hashMemoryText } from "./store"` 不破坏。
 */

/** 规范化 text：trim + 折叠连续空白（去重稳定性）。 */
export function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** 计算 textHash：规范化 text 的 sha256（前 64 hex）。 */
export function hashMemoryText(text: string): string {
  return createHash("sha256").update(normalizeMemoryText(text)).digest("hex").slice(0, 64);
}
