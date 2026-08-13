import {
  DEFAULT_TEST_FILE_PATTERN_SOURCE,
  type PolicyConfig,
  defaultPolicyConfig,
  makeTestFileDetect,
} from "@/lib/policy/config";

/**
 * Stage E：DB policy 行 → 运行时 PolicyConfig 解释器。
 *
 * DB 存纯数据（正则源 string + testFilePattern string），含函数成员的 PolicyConfig 不可直接序列化，
 * 故解释器负责：
 * - 把 string[] 编译成 RegExp[]（protectedPaths / commandDenyList）。
 * - 用 testFilePattern 重建 detect 闭包（verifyBeforeDelivery）。
 * - 缺键 / 非法正则 / 形状不符 → 回退 `defaultPolicyConfig` 对应字段（fail-soft，不抛、不破坏生成主链路）。
 *
 * 与 config.ts 互引：config 在 refreshPolicyConfigFromDB 内调用 interpretPolicyConfig（函数体，
 * live binding），无顶层循环求值，ESM 下安全。
 */

export type PolicyConfigRow = { key: string; value: unknown };

/** 安全编译单个正则源；失败返回 null（调用方决定回退）。 */
function safeCompile(source: string): RegExp | null {
  // ReDoS 源码级检测——拒绝灾难性回溯模式（嵌套量词如 (a+)+、(a*)*、(a|a)* 等）。
  if (isReDoSRisky(source)) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/**
 * 检测 ReDoS 风险正则源（启发式）。
 * 命中以下模式视为高风险 → 拒绝编译（fail-closed，回退默认规则）：
 * - 嵌套量词：`(...)+ ... +` 或 `(...)* ... *`（量词内含量词的捕获组后紧跟量词）
 * - 重叠交替 + 量词：`(a|a)+`、`(a+|a+)+` 等
 * 不追求完备（完备需 Worker 超时），只挡常见灾难性模式。
 */
function isReDoSRisky(source: string): boolean {
  // 嵌套量词：(group)(quantifier)(quantifier) —— 捕获/非捕获组后紧跟量词，且组内含量词
  // 简化检测：`([^\)]*[+*?][^\)]*)[+*?]` 形如 (a+) 或 (a*) 后跟 +/*/?
  if (/\([^()]*[+*?][^()]*\)[+*?]/.test(source)) return true;
  // 重叠交替量词：(a|a)+ 形式
  if (/\(([^|()]+)\|(\1)\)[+*?]/.test(source)) return true;
  return false;
}

/**
 * 编译正则源数组：全部编译成功 → 返回新数组；任一非法 / 非数组 → 回退默认（整字段 fail-soft）。
 * 整字段回退比部分应用更安全：部分 deny 列表会留下意外的拦截空洞。
 */
function compileRegexList(src: unknown, fallback: RegExp[]): RegExp[] {
  if (!Array.isArray(src)) return fallback;
  const out: RegExp[] = [];
  for (const s of src) {
    if (typeof s !== "string") return fallback;
    const re = safeCompile(s);
    if (!re) return fallback;
    out.push(re);
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function asStr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * 把 DB 行集合解释为运行时 PolicyConfig。缺键 / 非法值逐字段回退默认。
 */
export function interpretPolicyConfig(rows: PolicyConfigRow[]): PolicyConfig {
  const byKey = new Map<string, unknown>();
  for (const r of rows) byKey.set(r.key, r.value);

  const protectedPaths = compileRegexList(
    byKey.get("protectedPaths"),
    defaultPolicyConfig.protectedPaths,
  );
  const commandDenyList = compileRegexList(
    byKey.get("commandDenyList"),
    defaultPolicyConfig.commandDenyList,
  );

  const fowRaw = byKey.get("formatOnWrite");
  const formatOnWrite =
    isObject(fowRaw) && "command" in fowRaw
      ? {
          enabled: asBool(fowRaw.enabled, defaultPolicyConfig.formatOnWrite.enabled),
          command: asStr(fowRaw.command, defaultPolicyConfig.formatOnWrite.command),
        }
      : defaultPolicyConfig.formatOnWrite;

  const vRaw = byKey.get("verifyBeforeDelivery");
  const defV = defaultPolicyConfig.verifyBeforeDelivery;
  const verifyBeforeDelivery =
    isObject(vRaw) && "command" in vRaw
      ? (() => {
          const patternSrc = asStr(vRaw.testFilePattern, DEFAULT_TEST_FILE_PATTERN_SOURCE);
          const pattern = safeCompile(patternSrc) ?? new RegExp(DEFAULT_TEST_FILE_PATTERN_SOURCE);
          return {
            enabled: asBool(vRaw.enabled, defV.enabled),
            detect: makeTestFileDetect(pattern),
            command: asStr(vRaw.command, defV.command),
            timeoutMs: asNum(vRaw.timeoutMs, defV.timeoutMs),
            timeoutIsFailure: asBool(vRaw.timeoutIsFailure, defV.timeoutIsFailure),
          };
        })()
      : defV;

  return { protectedPaths, commandDenyList, formatOnWrite, verifyBeforeDelivery };
}
