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

/**
 * 专题01 §23.2 最终 Architecture Gate 边界规则的纯规则模块。
 *
 * 业务不变量（与 architecture-gate.ts 原有 checkTopic01Boundaries 一致，抽取为
 * 可单测纯函数）：
 * - 生产作用域 app/components/desktop/lib/scripts；docs 是方案说明文档（含被禁词
 *   是为了描述检测项），不扫。
 * - 排除 .test.ts/.test.tsx（断言文件可构造旧场景）。
 * - 规则定义文件 scripts/architecture-gate.ts 与 scripts/architecture-gate-rules.ts
 *   自身含这些标识符（作为检测正则），按文件精确排除，不得目录豁免。
 * - 剥离行/块注释后再匹配，注释中的被禁词不视为违规。
 * - /test-support/ 不因路径 blanket 豁免——由规则自行过滤，仅 .test.* 与显式精确
 *   文件白名单跳过。
 *
 * 覆盖：
 * - Thread.primaryAgentId / primary_agent_id 作为身份字段（Thread 不绑主 Agent）
 * - CreateThread 正式 route app/api/v1/threads/route.ts 可执行代码出现 agent_id
 *   字段即违规（不区分 required/optional）
 * - DEFAULT_AGENT_KEY / seedDefaultAgent（无默认 Agent fallback）
 * - defaultAgentId（新建不默认选中 Agent）
 * - agentKey === 'default' fallback
 * - threadId === 'new'、JSX threadId="new"、JSX threadId={'new'}（假 Thread）
 * - '/chat/new'、'/desktop/new' 假 new 路由
 * - 任意正式消费者 route.kind === 'chat'、lib/routes 内 kind: 'chat'
 * - 客户端 agents.length===0 执行阻断（return/throw，允许可选大括号）
 */
const TOPIC01_SCOPE = /^(app|components|desktop|lib|scripts)\//;

/** 规则定义文件（含检测正则自身），按文件精确排除。 */
const TOPIC01_RULE_DEFINITIONS = new Set([
  "scripts/architecture-gate.ts",
  "scripts/architecture-gate-rules.ts",
]);

/** CreateThread 正式 route：其可执行代码只要出现 agent_id 字段即违规。 */
const TOPIC01_CREATE_THREAD_ROUTE = "app/api/v1/threads/route.ts";

/** 专题01 边界规则模式。 */
const TOPIC01_BOUNDARY_PATTERNS: ReadonlyArray<{ pattern: RegExp; title: string }> = [
  {
    pattern: /\.primaryAgentId\b|\bprimaryAgentId\s*:|\bprimary_agent_id\b/,
    title: "Thread.primaryAgentId 身份字段",
  },
  { pattern: /\bDEFAULT_AGENT_KEY\b/, title: "DEFAULT_AGENT_KEY" },
  { pattern: /\bseedDefaultAgent\b/, title: "seedDefaultAgent" },
  { pattern: /\bdefaultAgentId\b/, title: "defaultAgentId" },
  { pattern: /\bagentKey\b\s*===?\s*["']default["']/i, title: "agentKey=default fallback" },
  { pattern: /threadId\s*===\s*["']new["']/, title: "threadId=new 假 Thread" },
  { pattern: /threadId\s*=\s*["']new["']/, title: "threadId=new 假 Thread" },
  { pattern: /threadId\s*=\s*\{\s*["']new["']\s*\}/, title: "threadId=new 假 Thread" },
  { pattern: /["']\/chat\/new["']/, title: "/chat/new 假 new 路由" },
  { pattern: /["']\/desktop\/new["']/, title: "/desktop/new 假 new 路由" },
  { pattern: /route\.kind\s*===\s*["']chat["']/, title: "route.kind=chat 漂移" },
  {
    // §35：仅禁止「agents.length===0 执行阻断」（return/throw，允许可选大括号）。
    // 「暂无可用助手」空态展示（agents.length === 0 && <SelectorMessage>）合法，不匹配。
    pattern: /agents\.length\s*===?\s*0\s*\)?\s*\{?\s*(?:return|throw)/,
    title: "客户端 agents.length===0 执行阻断",
  },
];

/** 剥离行/块注释，仅剩可执行代码，用于边界规则文本扫描。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * 收集专题01 §23.2 边界规则违规路径。
 *
 * 对每个在生产作用域内、非 .test.ts/.test.tsx、非规则定义文件的文档，剥离注释后
 * 匹配边界模式；命中任一规则即计入违规。返回唯一 path，保持输入顺序。
 *
 * @param documents 全部候选文档（含 test-support 与测试文件，规则自行过滤）。
 * @returns 违规 path，保持输入顺序、唯一。
 */
export function collectTopic01BoundaryViolations(documents: readonly SourceDocument[]): string[] {
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const document of documents) {
    const path = document.path;
    if (!TOPIC01_SCOPE.test(path)) continue;
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    if (TOPIC01_RULE_DEFINITIONS.has(path)) continue;
    const source = stripComments(document.source);
    let flagged = false;
    // CreateThread 正式 route：出现 agent_id 字段即违规（不区分 required/optional）。
    if (path === TOPIC01_CREATE_THREAD_ROUTE && /\bagent_id\b/.test(source)) {
      flagged = true;
    }
    if (!flagged) {
      for (const rule of TOPIC01_BOUNDARY_PATTERNS) {
        if (rule.pattern.test(source)) {
          flagged = true;
          break;
        }
      }
    }
    // 正式 Route 系统（lib/routes）不得出现 chat kind 漂移。
    if (!flagged && path.startsWith("lib/routes/") && /kind\s*[:=]\s*["']chat["']/.test(source)) {
      flagged = true;
    }
    if (flagged && !seen.has(path)) {
      seen.add(path);
      violations.push(path);
    }
  }
  return violations;
}
