/**
 * V11 内容寻址缓存工具（阶段 6 S06-C01）。
 *
 * 用于 SkillVersion 内容 hash 计算与校验：
 * - 计算 content hash（sha256: 前缀 + 64 hex）。
 * - 校验 content hash 是否匹配。
 * - 验证 hash 格式（sha256: + 64 hex）。
 *
 * hash 前缀 `sha256:` 与项目约定一致（见 lib/persistence/schema/skill.ts contentHash 字段）。
 */
import { createHash } from "node:crypto";

/** hash 前缀（与项目其他 hash 字段一致）。 */
export const CONTENT_HASH_PREFIX = "sha256:";

/** sha256 hex 长度（64 字符）。 */
export const SHA256_HEX_LENGTH = 64;

/**
 * 计算 content hash（sha256: 前缀 + 64 hex）。
 *
 * @param content 原始内容（utf-8 编码后哈希）
 * @returns 形如 `sha256:<64-hex>` 的 hash 字符串
 */
export function computeContentHash(content: string): string {
  const hex = createHash("sha256").update(content, "utf-8").digest("hex");
  return `${CONTENT_HASH_PREFIX}${hex}`;
}

/**
 * 校验 content hash 是否匹配。
 *
 * - expectedHash 格式非法 → 返回 false（fail-closed，不抛错）。
 * - 计算 content 的实际 hash 与 expectedHash 严格相等 → true。
 *
 * @param content 原始内容
 * @param expectedHash 期望的 hash（sha256: 前缀 + 64 hex）
 */
export function verifyContentHash(content: string, expectedHash: string): boolean {
  if (!isValidContentHash(expectedHash)) return false;
  const actual = computeContentHash(content);
  return actual === expectedHash;
}

/**
 * 验证 hash 格式（sha256: 前缀 + 64 hex）。
 *
 * @param hash 待校验的 hash 字符串
 * @returns 格式合法返回 true，否则 false
 */
export function isValidContentHash(hash: string): boolean {
  if (!hash.startsWith(CONTENT_HASH_PREFIX)) return false;
  const hex = hash.slice(CONTENT_HASH_PREFIX.length);
  if (hex.length !== SHA256_HEX_LENGTH) return false;
  return /^[0-9a-f]{64}$/.test(hex);
}
