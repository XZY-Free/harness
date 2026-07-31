import { isMasterKeyConfigured } from "./secret-crypto";

/**
 * V3.8 Stage C：Secret 脱敏注册表（全链路防泄露）。
 *
 * 维护当前 thread 解析出的 secret 明文值集合（运行时内存），供：
 * - `executeToolRun` 输出扫描替换 `***`
 * - `logger` 日志扫描替换 `***`
 * - manifest / context 不含 secret 值
 *
 * 生命周期：per-thread 注册（resolveSecrets 时），请求结束清除。
 * 非线程安全的全局 Map（单进程多 thread 各自注册，互不影响）。
 */

/** per-thread secret 明文值集合。 */
const threadSecrets = new Map<string, Set<string>>();

/**
 * S1 修复（02-P2-2）：secret 最小长度。
 *
 * 原实现只过滤空串，1-3 字符的短 secret 会把正文里同字符串误替换成 `***`（如 secret="ab"
 * 会把所有 "ab" 子串脱敏，破坏输出可读性）。短于阈值的值不注册脱敏（仍可作为 env 注入，
 * 只是不进 redact 扫描集合）。
 */
const MIN_SECRET_LEN = 4;

/**
 * 注册 thread 的 secret 明文值（供脱敏扫描）。
 * 每次 resolveSecrets 调用前先 clearThread 再注册新值（轮换后旧值清除）。
 */
export function registerSecretValues(threadId: string, values: string[]): void {
  const set = new Set<string>();
  for (const v of values) {
    if (v.length >= MIN_SECRET_LEN) set.add(v);
  }
  threadSecrets.set(threadId, set);
}

/** 清除 thread 的 secret 明文值（请求结束/容器停止时调）。 */
export function clearThreadSecrets(threadId: string): void {
  threadSecrets.delete(threadId);
}

/**
 * 脱敏文本：将已知 secret 明文值替换为 `***`。
 *
 * 扫描 thread 注册的所有 secret 值，逐个替换。
 * 空值/未注册 → 原样返回（零回归）。
 */
export function redactText(text: string, threadId: string): string {
  const secrets = threadSecrets.get(threadId);
  if (!secrets || secrets.size === 0) return text;
  // 审计修复：按长度降序排列 secret，长值优先替换。防止短 secret 是长 secret 的子串时，
  // 先替换短值会破坏长值的完整性（如 secret1="abc", secret2="abcdef"，先替 abc → "***def"
  // 导致 abcdef 无法完整匹配）。
  const sorted = [...secrets].sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of sorted) {
    if (secret.length > 0 && result.includes(secret)) {
      result = result.split(secret).join("***");
    }
  }
  return result;
}

/**
 * 脱敏对象（深遍历，替换所有 string 值中的 secret）。
 * 用于 ToolRun output / event payload 等结构化数据。
 *
 * 审计修复：加入 WeakSet 防止循环引用导致无限递归（stack overflow）。
 */
export function redactObject<T>(obj: T, threadId: string): T {
  const secrets = threadSecrets.get(threadId);
  if (!secrets || secrets.size === 0) return obj;
  const visited = new WeakSet<object>();
  return redactObjectInner(obj, secrets, visited) as T;
}

function redactObjectInner(obj: unknown, secrets: Set<string>, visited: WeakSet<object>): unknown {
  if (typeof obj === "string") return redactTextFromSet(obj, secrets);
  if (obj === null || typeof obj !== "object") return obj;
  // 审计修复：Date/Error/Buffer 等非普通对象直接返回（不遍历），防止 Object.entries
  // 返回空数组导致这些对象被静默破坏为 {}。
  if (obj instanceof Date || obj instanceof Error || obj instanceof RegExp) return obj;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(obj)) return obj;
  // 审计修复：循环引用检测，防止无限递归
  if (visited.has(obj as object)) return obj;
  visited.add(obj as object);
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObjectInner(item, secrets, visited));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = redactObjectInner(value, secrets, visited);
  }
  return result;
}

/** 内部 helper：用已排序的 secret 集合做替换（避免重复排序）。 */
function redactTextFromSet(text: string, secrets: Set<string>): string {
  const sorted = [...secrets].sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of sorted) {
    if (secret.length > 0 && result.includes(secret)) {
      result = result.split(secret).join("***");
    }
  }
  return result;
}

/** 检查 secret mount 是否可用（master key 已配置）。 */
export function isSecretMountAvailable(): boolean {
  return isMasterKeyConfigured();
}

/**
 * 审计修复：全局脱敏——扫描所有已注册 thread 的 secret 值并替换。
 * 供 logger 等无法确定 threadId 的场景使用（原 redactText 仅查指定 threadId 的 secret，
 * 无 threadId 时完全无脱敏）。
 * 性能：遍历所有线程的 secret 集合，通常线程数有限（<100），可接受。
 */
export function redactTextGlobal(text: string): string {
  // 审计修复：收集所有 thread 的 secret 后按长度降序排列，长值优先替换
  const allSecrets: string[] = [];
  for (const secrets of threadSecrets.values()) {
    for (const s of secrets) {
      if (s.length > 0) allSecrets.push(s);
    }
  }
  if (allSecrets.length === 0) return text;
  allSecrets.sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of allSecrets) {
    if (result.includes(secret)) {
      result = result.split(secret).join("***");
    }
  }
  return result;
}

/** 全局脱敏对象（深遍历，替换所有 thread 的 secret）。
 * 审计修复：加入 WeakSet 防止循环引用 + 按长度降序排列 secret。 */
export function redactObjectGlobal<T>(obj: T): T {
  const visited = new WeakSet<object>();
  return redactObjectGlobalInner(obj, visited) as T;
}

function redactObjectGlobalInner(obj: unknown, visited: WeakSet<object>): unknown {
  if (typeof obj === "string") return redactTextGlobal(obj);
  if (obj === null || typeof obj !== "object") return obj;
  // 审计修复：Date/Error/Buffer 等非普通对象直接返回，同 redactObjectInner
  if (obj instanceof Date || obj instanceof Error || obj instanceof RegExp) return obj;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(obj)) return obj;
  if (visited.has(obj as object)) return obj;
  visited.add(obj as object);
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObjectGlobalInner(item, visited));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = redactObjectGlobalInner(value, visited);
  }
  return result;
}
