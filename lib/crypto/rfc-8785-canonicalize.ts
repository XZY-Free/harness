/**
 * RFC 8785 JSON Canonicalization Scheme 实现。
 *
 * 替换手写递归排序算法(sortKeys)，用于跨系统签名和Digest计算。
 * RFC 8785 专门定义了适用于哈希和签名的稳定 JSON 表示。
 *
 * 规则概要：
 * - ES6 number serialization (Infinity/NaN → throw)
 * - 字符串: 仅转义必要字符, U+2028/U+2029 转义
 * - 对象键按 UTF-16 码元排序 (RFC 8785 §3.2.3)
 * - 数组保持原始顺序
 * - 无空白
 */

import { createHash } from "node:crypto";

/**
 * RFC 8785 JSON Canonicalization — 将任意 JSON 值转换为规范字符串。
 *
 * @throws {TypeError} 值包含 Infinity, -Infinity, NaN, undefined, BigInt 或循环引用时
 */
export function rfc8785Canonicalize(value: unknown): string {
  return serialize(value, new WeakSet());
}

/**
 * 计算规范 JSON 的 SHA-256 Digest。
 *
 * @returns `sha256:` 前缀的十六进制摘要
 */
export function computeCanonicalDigest(value: unknown): string {
  const canonical = rfc8785Canonicalize(value);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hex}`;
}

// ─── 内部序列化 ────────────────────────────────────────────

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (value === undefined) throw new TypeError("RFC 8785: undefined 不可序列化");

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      return serializeNumber(value);

    case "string":
      return serializeString(value);

    case "bigint":
      throw new TypeError("RFC 8785: BigInt 不可序列化");

    case "object": {
      if (seen.has(value as object)) {
        throw new TypeError("RFC 8785: 循环引用不可序列化");
      }
      seen.add(value as object);

      if (Array.isArray(value)) {
        const items = value.map((item) => serialize(item, seen));
        return `[${items.join(",")}]`;
      }

      return serializeObject(value as Record<string, unknown>, seen);
    }

    default:
      throw new TypeError(`RFC 8785: 不支持类型 ${typeof value}`);
  }
}

/**
 * ES6 Number serialization (RFC 8785 §3.2.1)。
 */
function serializeNumber(value: number): string {
  if (Number.isNaN(value)) throw new TypeError("RFC 8785: NaN 不可序列化");
  if (!Number.isFinite(value)) throw new TypeError("RFC 8785: Infinity 不可序列化");
  return JSON.stringify(value);
}

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR
// Cannot embed these directly in source — they break esbuild's parser.
// Use String.fromCharCode to construct them at runtime.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * String serialization (RFC 8785 §3.2.2)。
 *
 * 仅转义必要字符。U+2028 和 U+2029 在 JSON 中不必须转义，但 RFC 8785 要求转义。
 */
function serializeString(value: string): string {
  let result = JSON.stringify(value);
  // JSON.stringify may or may not escape U+2028/U+2029 depending on engine
  // RFC 8785 requires they be escaped
  if (result.includes(LINE_SEPARATOR)) {
    result = result.split(LINE_SEPARATOR).join("\\u2028");
  }
  if (result.includes(PARAGRAPH_SEPARATOR)) {
    result = result.split(PARAGRAPH_SEPARATOR).join("\\u2029");
  }
  return result;
}

/**
 * Object serialization (RFC 8785 §3.2.3)。
 *
 * 键按 UTF-16 码元排序（不是 Unicode 码点）。
 */
function serializeObject(obj: Record<string, unknown>, seen: WeakSet<object>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";

  // RFC 8785 键排序：UTF-16 码元字典序
  keys.sort((a, b) => {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const ca = a.charCodeAt(i);
      const cb = b.charCodeAt(i);
      if (ca !== cb) return ca - cb;
    }
    return a.length - b.length;
  });

  const entries = keys.map((key) => {
    const value = obj[key];
    return `${serializeString(key)}:${serialize(value, seen)}`;
  });

  return `{${entries.join(",")}}`;
}
