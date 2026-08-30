/**
 * RouteSelector — 路由选择纯计算。
 *
 * 所有 Eligibility 规范化、Specificity 计算、条件重叠判断和 Selector Digest 计算
 * 集中于此。Resolver、RouteSetActivationPolicy 和测试必须引用同一套算法。
 *
 * 不得负责：数据库读取、Route 选择、权重随机、API 错误映射。
 */
import { createHash } from "node:crypto";

/** Selector 算法版本 — 稳定 Digest 载荷中，确保算法变更产生不同 Digest。 */
export const SELECTOR_ALGORITHM_VERSION = "route-selector/v1";

// ─── Eligibility 条件类型 ──────────────────────────────────

/**
 * 规范化 Eligibility 等值合取条件。
 *
 * 形如: { all: { environment: "prod", region: "cn" } }
 * 键按规范化后的字母序排列，确保同语义条件产生相同 Digest。
 */
export interface NormalizedEligibility {
  readonly all: Readonly<Record<string, string | number | boolean>>;
}

/**
 * 将原始 Eligibility 条件规范化为等值合取形式。
 *
 * 规则：
 * - 必须是 `{ all: { ... } }` 结构
 * - `all` 内每个键的值必须是标量(string/number/boolean)
 * - number 值不得为 NaN、Infinity、-Infinity
 * - **Fail-closed**：遇到任何不支持值时整体返回 null，不静默过滤
 * - 输出键按字母序排列
 * - 空条件（无约束）规范化为 `{ all: {} }`
 *
 * 参见：正式架构
 */
export function normalizeEligibility(conditions: unknown): NormalizedEligibility | null {
  if (conditions === null || conditions === undefined) {
    return { all: {} };
  }
  if (!isPlainObject(conditions)) return null;
  const keys = Object.keys(conditions);
  if (keys.length === 0) {
    return { all: {} };
  }
  if (keys.length !== 1 || keys[0] !== "all") return null;
  const all = (conditions as Record<string, unknown>).all;
  if (!isPlainObject(all)) return null;

  const rawEntries = Object.entries(all as Record<string, unknown>);
  // Fail-closed: 任何非标量或非有限数值 → 整体失败
  for (const [key, value] of rawEntries) {
    if (!isScalar(value)) return null;
    if (typeof value === "number" && !Number.isFinite(value)) return null;
  }

  const entries = rawEntries.sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return { all: {} };
  }
  return { all: Object.fromEntries(entries) as Record<string, string | number | boolean> };
}

/**
 * 计算 Eligibility 条件的 Specificity。
 *
 * Specificity = 规范化后 `all` 中键的数量。
 * 空条件的 Specificity = 0（最宽匹配）。
 */
export function computeSpecificity(normalized: NormalizedEligibility): number {
  return Object.keys(normalized.all).length;
}

/**
 * 计算规范化 Eligibility 条件的稳定 Selector Digest。
 *
 * 载荷格式：[算法版本, 排序键值对数组]
 * 确保同语义条件产生相同 Digest，不同语义产生不同 Digest。
 */
export function computeSelectorDigest(normalized: NormalizedEligibility): string {
  const payload = JSON.stringify([
    SELECTOR_ALGORITHM_VERSION,
    Object.entries(normalized.all).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/**
 * 判断两个规范化 Eligibility 条件是否存在重叠（即存在至少一组输入可同时满足两者）。
 *
 * 等值合取条件下：
 * - 如果存在同一个键但值不同 → 不重叠
 * - 否则 → 重叠（至少一组输入可同时满足）
 */
export function isOverlapping(left: NormalizedEligibility, right: NormalizedEligibility): boolean {
  const leftEntries = Object.entries(left.all);
  for (const [key, leftValue] of leftEntries) {
    const rightValue = right.all[key];
    if (rightValue !== undefined && leftValue !== rightValue) {
      return false;
    }
  }
  return true;
}

/**
 * 判断两个时间窗口是否存在重叠。
 *
 * null 表示无边界约束。
 */
export function isTimeWindowOverlapping(
  leftFrom: Date | null,
  leftUntil: Date | null,
  rightFrom: Date | null,
  rightUntil: Date | null,
): boolean {
  const effectiveLeftFrom = leftFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
  const effectiveLeftUntil = leftUntil?.getTime() ?? Number.POSITIVE_INFINITY;
  const effectiveRightFrom = rightFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
  const effectiveRightUntil = rightUntil?.getTime() ?? Number.POSITIVE_INFINITY;

  return effectiveLeftFrom < effectiveRightUntil && effectiveRightFrom < effectiveLeftUntil;
}

// ─── 内部工具 ──────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
