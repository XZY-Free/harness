/**
 * Architecture Gate 的 deprecated/legacy 检查纯规则模块。
 *
 * 业务不变量：/test-support/ 不因路径整体豁免——只允许 .test.ts/.test.tsx 与
 * 显式精确文件白名单跳过。本模块接收 SourceDocument 数组，返回违规路径数组，
 * 保持输入顺序并去重。scope 与禁词语义与 architecture-gate.ts 原有
 * checkDeprecatedArchitecture 一致，抽取为可单测的纯函数。
 */

/** 目标作用域前缀：正式领域（lib/{agents,artifacts,executions,publications,routes,runtime}）与 admin 管理 API。 */
const SCOPED_PATTERN =
  /^(lib\/(agents|artifacts|executions|publications|routes|runtime)\/|app\/admin\/api\/v1\/)/;

/** deprecated 禁词（大小写不敏感）：@deprecated、单词 legacy/cutover/shadow、fallback legacy。 */
const DEPRECATED_PATTERN = /@deprecated|\blegacy\b|\bcutover\b|\bshadow\b|fallback legacy/i;

export interface SourceDocument {
  path: string;
  source: string;
}

/**
 * 收集已废弃架构表述违规路径。
 *
 * 对每个在目标作用域内、非 .test.ts/.test.tsx 的文档，若其 source 命中禁词且
 * 不在精确 allowlist 中，则计入违规。allowlist 仅接受 Set.has(path) 的精确文件
 * 匹配；绝不按 path.includes('/test-support/') 或目录前缀做整体豁免。
 *
 * @param documents 全部候选文档（含 test-support 与测试文件，规则自行过滤）。
 * @param allowlist 精确文件白名单（逐文件，非目录前缀）。
 * @returns 违规 path，保持输入顺序、唯一。
 */
export function collectDeprecatedArchitectureViolations(
  documents: readonly SourceDocument[],
  allowlist: ReadonlySet<string> = new Set<string>(),
): string[] {
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const document of documents) {
    if (!SCOPED_PATTERN.test(document.path)) continue;
    if (document.path.endsWith(".test.ts") || document.path.endsWith(".test.tsx")) continue;
    if (allowlist.has(document.path)) continue;
    if (!DEPRECATED_PATTERN.test(document.source)) continue;
    if (seen.has(document.path)) continue;
    seen.add(document.path);
    violations.push(document.path);
  }
  return violations;
}
