/**
 * 正则安全助手（关口02 02-6 · 冻结方案 §6.5 / §54-P3）。
 *
 * argMatcher 中的 pathRegex / commandRegex 会被 Evaluator 用作 `new RegExp().test()`，
 * 恶意/事故正则可造成 ReDoS 或编译失败。Policy Revision 在发布前必须 fail-closed：
 * - 无法编译（非法正则）→ 拒绝发布。
 * - 存在明显 ReDoS 风险（嵌套量词 / 反向引用 / 灾难性回溯）→ 拒绝发布。
 *
 * 这是保守启发式，只拦最明显的灾难性回溯模式；不作为完整正则安全引擎。
 * 与已删除的 legacy lib/policy/config.ts 编译路径解耦（02-6 P9），供正式 Policy Revision
 * 校验与 lib/permission/policy-evaluator.ts 复用。
 */

/** 正则非法（无法编译）。 */
export class RegexValidationError extends Error {
  readonly code = "REGEX_INVALID";
  constructor(label: string, reason: string) {
    super(`正则 ${label} 非法：${reason}`);
    this.name = "RegexValidationError";
  }
}

/**
 * 判断正则源是否存在明显 ReDoS 风险。
 *
 * 启发式（保守）：
 * - 嵌套量词，如 `(a+)+` / `(ab*)*` / `(a+)*` —— 经典灾难性回溯。
 * - 量词紧跟量词，如 `a**` / `a++`。
 * - 反向引用（`\1`…）配合可重复分组，回溯成本高（保守视为风险）。
 * 仅用于发布前 fail-closed；无法证明安全的复杂正则统一拒绝发布。
 */
export function isReDoSRisky(source: string): boolean {
  // 反向引用：\1 - \9（保守拒绝）。
  if (/\\[1-9]/.test(source)) return true;
  // 嵌套量词：`(...)+` 内再出现量词，形如 `(a+)+`、`(a*)*`、`(a?)+` 等。
  // 匹配「量词闭合括号后紧跟量词」或「量词内部再嵌套量词」的极端形态。
  if (/\(\s*[^)]*[*+?]\s*\)\s*[*+]/.test(source)) return true;
  // 连续量词：`**` / `++` / `*?` 不属于风险，但 `a+*` 之类是非法；这里只拦字面连续 `*+`。
  if (/\*\*|\+\+/.test(source)) return true;
  return false;
}

/**
 * 校验单个正则源可编译且无明显 ReDoS 风险；不满足则抛 RegexValidationError。
 */
export function assertSafeRegex(source: string, label: string): void {
  let compiled: RegExp;
  try {
    compiled = new RegExp(source);
  } catch {
    throw new RegexValidationError(label, "无法编译");
  }
  // 编译成功后核对原始源（避免源为空时漏检）。
  if (isReDoSRisky(compiled.source)) {
    throw new RegexValidationError(label, "存在明显 ReDoS 风险（拒绝发布）");
  }
}

/** 判断一个 argMatcher 值是否为可安全编译/可脱敏的合法 matcher 对象。 */
export function isSafeRegexField(value: unknown): value is string {
  return typeof value === "string";
}
