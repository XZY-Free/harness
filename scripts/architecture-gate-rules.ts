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

export interface AgentInvokeAuthorizationGateResult {
  passed: boolean;
  failures: string[];
}

export interface AgentCallFinalizationGateResult {
  passed: boolean;
  failures: string[];
}

/** Package03：AgentCall 只能通过单一最终事务冻结，禁止旧幂等入口与假事实。 */
export function checkAgentCallFinalizationGate(
  documents: readonly SourceDocument[],
): AgentCallFinalizationGateResult {
  const failures: string[] = [];
  const source = (path: string) =>
    documents.find((document) => document.path === path)?.source ?? "";
  const createApplication = stripComments(
    source("lib/agents/calls/application/create-agent-call.ts"),
  );
  const store = stripComments(source("lib/agents/calls/persistence/mysql-agent-call-store.ts"));
  const resolver = stripComments(
    source("lib/agents/calls/application/resolve-agent-call-binding.ts"),
  );
  const schema = stripComments(source("lib/persistence/schema/agent-calls.ts"));

  if (!createApplication.includes("finalizeAgentCall")) {
    failures.push("AgentCall creation 未委托 finalizeAgentCall");
  }
  if (/\brecordCapabilityUse(?:InSession)?\s*\(/.test(createApplication)) {
    failures.push("AgentCall creation 仍在事务外写 CapabilityUse");
  }
  if (
    !store.includes("finalizeAgentCall") ||
    !store.includes("lockAndValidateAgentCallAuthority") ||
    !store.includes("recordCapabilityUse")
  ) {
    failures.push("mysql AgentCall Store 未统一 Authority/CapabilityUse 最终事务");
  }
  if (
    !resolver.includes("bindingCandidate") ||
    !resolver.includes("buildAgentCallBindingCandidate")
  ) {
    failures.push("Agent Route Resolver 仍把事务外结果声明为最终 Binding");
  }
  if (!schema.includes("creationRequestDigest") || !schema.includes("projectionVersionNo")) {
    failures.push("AgentCall Schema 缺 creationRequestDigest/projectionVersionNo");
  }

  for (const document of documents) {
    if (!document.path.startsWith("lib/agents/calls/") || document.path.includes(".test."))
      continue;
    const productionSource = stripComments(document.source);
    if (/\bcreateIdempotent\b/.test(productionSource)) {
      failures.push(`AgentCall 旧 createIdempotent 入口仍存在：${document.path}`);
    }
    if (
      /projectionVersionNo\s*\?\?\s*0/.test(productionSource) ||
      /(?:endpointRef|networkZone)\s*\?\?\s*["']{2}/.test(productionSource)
    ) {
      failures.push(`AgentCall 假事实 fallback 仍存在：${document.path}`);
    }
    if (/\bAgent\.?currentRevisionId\b|\bagent\.currentRevisionId\b/.test(productionSource)) {
      failures.push(`AgentCall 执行读取 Agent.currentRevisionId：${document.path}`);
    }
  }

  return { passed: failures.length === 0, failures: [...new Set(failures)] };
}

/** Agent 发现与 Turn 选择必须共用 RoleActionBinding 授权。 */
export function checkAgentInvokeAuthorizationGate(
  documents: readonly SourceDocument[],
): AgentInvokeAuthorizationGateResult {
  const failures: string[] = [];
  const source = (path: string) => documents.find((document) => document.path === path)?.source;
  const actionCodes = source("lib/identity/action-codes.ts") ?? "";
  if (!actionCodes.includes('"agent.invoke"')) {
    failures.push("agent.invoke 未进入稳定 ActionCode 目录");
  }
  if (!/"agent\.invoke"\s*:\s*\["tenant",\s*"agent"\]/.test(actionCodes)) {
    failures.push("agent.invoke resource types 不是 tenant | agent");
  }

  if (source("app/api/v1/agents/route.ts") !== undefined) {
    failures.push("员工 /api/v1/agents 双轨入口仍存在");
  }

  for (const document of documents) {
    if (
      document.path.includes(".test.") ||
      document.path === "scripts/architecture-gate-rules.ts" ||
      document.path === "scripts/architecture-gate.ts"
    ) {
      continue;
    }
    if (/visibilityPolicyId|visibility_policy_id/.test(stripComments(document.source))) {
      failures.push(`visibility policy 旧 Authority 仍存在：${document.path}`);
    }
  }

  const turnRoute = source("app/api/v1/threads/[thread_id]/turns/route.ts") ?? "";
  const authorizationIndex = turnRoute.indexOf("requireAgentInvokeScope(");
  const idempotencyIndex = turnRoute.indexOf("enforceIdempotency(");
  if (authorizationIndex < 0 || idempotencyIndex < 0 || authorizationIndex > idempotencyIndex) {
    failures.push("Turn agent selection 未在幂等/写入前经过 requireAgentInvokeScope");
  }

  const catalogRoute = source("app/api/v1/catalog/options/route.ts") ?? "";
  if (
    !catalogRoute.includes("resolveActionScopeCoverage(") ||
    !catalogRoute.includes("agentInvokeAuthorization") ||
    !catalogRoute.includes("buildEmployeeCatalogEtag(")
  ) {
    failures.push("Employee Catalog 未绑定 agent.invoke 覆盖与授权摘要 ETag");
  }

  for (const document of documents) {
    if (!/^(app|components|desktop)\//.test(document.path) || document.path.includes(".test.")) {
      continue;
    }
    if (/['"]\/api\/v1\/agents['"]/.test(stripComments(document.source))) {
      failures.push(`客户端仍消费员工 /api/v1/agents：${document.path}`);
    }
  }

  return { passed: failures.length === 0, failures: [...new Set(failures)] };
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
    // 专题01 Batch4：RouteResolver 命令必须用显式 target:{kind:"runtime"|"agent"}，
    // 禁止再用 agentConstraint 隐式表达目标（隐式 null=Harness 的旧 Authority）。
    pattern: /\bagentConstraint\b/,
    title: "RouteResolver agentConstraint 隐式 target",
  },
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

// ─── A2A AgentCall 边界（Batch6）───────────────────────────

/**
 * 旧 A2A Runtime 生产路径：lib/runtime 下任意子目录的 a2a 前缀文件名
 * （含 transport/a2a-transport.ts、a2a-background-failure-handler.ts 等）。
 * 文件名自身为旧残留，无论内容（含注释）均违规。
 */
const OLD_A2A_RUNTIME_PATH = /^lib\/runtime\/(?:.*\/)?a2a/;

/** 从旧 A2A Runtime 路径 import/require/export-from（含别名）的模块引用。 */
const OLD_A2A_RUNTIME_REF =
  /(?:from\s*["']|require\(\s*["']|import\s+[^"'\n]*?\bfrom\s*["']|export\s+[^"'\n]*?\bfrom\s*["'])[^"']*lib\/runtime\/[^"']*\/?a2a[^"']*["']/;

/** 旧 A2A Runtime authority 标识符（全局生产作用域禁）。 */
const OLD_A2A_IDENTIFIERS = /\bA2AEventBatchSink\b|\bA2ARuntimeRefResolver\b/;

/**
 * Agent calls（transport/application/test-support）禁引用的 Runtime 渗漏：
 * RuntimeHttpClient、runtimeExecutionRef/runtimeSessionRef、RuntimeEventIngress、
 * markInvocationLost，或 runtime event-ingress/recovery 模块。ParentInvocationId 合法。
 */
const AGENT_CALLS_SCOPE = /^lib\/agents\/calls\/(transport|application|test-support)\//;
const AGENT_CALLS_FORBIDDEN =
  /\bRuntimeHttpClient\b|\bruntimeRevisionId\b|\bruntimeExecutionRef\b|\bruntimeSessionRef\b|\bRuntimeEventIngress\b|\bmarkInvocationLost\b|\/runtime\/(?:event-ingress|recovery|recovery-queries)/;

/** Agent target 对象不得同时构造 Runtime evidence 字段组。 */
const AGENT_TARGET_WITH_RUNTIME_EVIDENCE =
  /targetKind\s*:\s*["']agent["'][^{}]{0,800}\b(?:runtimeRevisionId|runtimePublicationRecordId|runtimeAttestationIds|runtimeConformanceValid)\s*:/;

/** Agent target 不得通过三元表达式回退成 Runtime target。 */
const AGENT_TARGET_RUNTIME_FALLBACK =
  /target(?:\.kind)?\s*===?\s*["']agent["']\s*\?\s*\{[^{}]{0,300}\bkind\s*:\s*["']runtime["']/;

/** RouteSet 唯一索引不得继续依赖 nullable agentId。 */
const ROUTE_SET_NULLABLE_AGENT_UNIQUE =
  /uniqueIndex\([\s\S]{0,300}?\.on\(\s*(?:\w+\.)?tenantId\s*,\s*(?:\w+\.)?agentId\s*,\s*(?:\w+\.)?routeScopeKey/;

/** Schema 已知 RUNTIME_PROTOCOL_TYPES 不得含 a2a（仅 schema 文件）。 */
const SCHEMA_RUNTIMES_PATH = "lib/persistence/schema/runtimes.ts";
const SCHEMA_PROTOCOL_A2A = /RUNTIME_PROTOCOL_TYPES\s*=\s*\[[^\]]*["']a2a["']/;

/** Runtime 生产 protocolType 赋值不得为 a2a（lib/runtime 下；AgentContractSnapshot 属 lib/agents 不受限）。 */
const RUNTIME_PROTOCOL_A2A = /protocolType\s*[:=]\s*["']a2a["']/;

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
    // Route target 必须保持判别互斥：Agent 对象不可携带 Runtime evidence，也不可
    // fallback 为 Runtime target。
    if (!flagged && AGENT_TARGET_WITH_RUNTIME_EVIDENCE.test(source)) {
      flagged = true;
    }
    if (!flagged && path.startsWith("lib/routes/") && AGENT_TARGET_RUNTIME_FALLBACK.test(source)) {
      flagged = true;
    }
    // RouteSet 唯一 Authority 必须由非空 targetKind + targetIdentity 构成。
    if (
      !flagged &&
      path === "lib/persistence/schema/deployment-route.ts" &&
      ROUTE_SET_NULLABLE_AGENT_UNIQUE.test(source)
    ) {
      flagged = true;
    }
    // ── A2A AgentCall 边界（Batch6）──
    // 旧 A2A Runtime 生产路径：文件名自身 lib/runtime/**/a2a* 即违规（无论内容/注释）。
    if (!flagged && OLD_A2A_RUNTIME_PATH.test(path)) {
      flagged = true;
    }
    // 从旧 A2A Runtime 路径 import/require/export-from（含别名）全局禁。
    if (!flagged && OLD_A2A_RUNTIME_REF.test(source)) {
      flagged = true;
    }
    // 旧 A2A Runtime authority 标识符全局禁。
    if (!flagged && OLD_A2A_IDENTIFIERS.test(source)) {
      flagged = true;
    }
    // Agent calls 作用域不得渗漏 Runtime 权威字段/标识符/模块。
    if (!flagged && AGENT_CALLS_SCOPE.test(path) && AGENT_CALLS_FORBIDDEN.test(source)) {
      flagged = true;
    }
    // Schema 已知 RUNTIME_PROTOCOL_TYPES 不得含 a2a。
    if (!flagged && path === SCHEMA_RUNTIMES_PATH && SCHEMA_PROTOCOL_A2A.test(source)) {
      flagged = true;
    }
    // Runtime 生产 protocolType 赋值不得为 a2a（lib/runtime/**，AgentContractSnapshot 属 lib/agents 不受限）。
    if (!flagged && path.startsWith("lib/runtime/") && RUNTIME_PROTOCOL_A2A.test(source)) {
      flagged = true;
    }
    if (flagged && !seen.has(path)) {
      seen.add(path);
      violations.push(path);
    }
  }
  return violations;
}

// ─── 剩余代码收口（V12/01 08 专项）边界规则 E1-E4 ─────────────

/**
 * E1-E4：本轮新增真实红线（生产作用域，剥离注释，排除 .test.* 与规则定义文件）：
 * - E1 A2A external production wire 不得出现 snowharness.execution_subject；
 * - E2 公共 subject 映射不得输出裸 "service"（必须 platform_service）；
 * - E3 Studio production 不得自行构造 conformance_run_id 字面量（只能来自 DTO）；
 * - E4 生产代码不得有 HR-specific runtime branch。
 */
const CLOSEOUT_BOUNDARY_PATTERNS: ReadonlyArray<{ pattern: RegExp; title: string }> = [
  { pattern: /snowharness\.execution_subject/, title: "E1 旧 namespaced execution_subject wire" },
  {
    // 捕获直接赋值与三元输出映射（"platform_service" 因引号边界不匹配）；
    // === / !== / < / > 后的 "service" 是比较而非输出，可变长 lookbehind 排除。
    pattern: /subject_kind\s*[:=][^;\n]{0,60}(?<![=!<>]\s*)["']service["']/,
    title: "E2 subject_kind 裸 service 输出",
  },
  {
    // 仅捕获对象字面量/赋值中的 run id 字符串字面量（=== 比较不匹配）。
    pattern: /conformance_run_id\s*:\s*["'][A-Za-z0-9][A-Za-z0-9_-]*["']/,
    title: "E3 Studio/生产自行构造 conformance_run_id 字面量",
  },
  { pattern: /\bhr-assistant\b/i, title: "E4 HR 特例分支" },
  { pattern: /\bveadk\b/i, title: "E4 HR 特例分支" },
  { pattern: /\bagentkit\b/i, title: "E4 HR 特例分支" },
  { pattern: /\bemployee-data\b/i, title: "E4 HR 特例分支" },
  { pattern: /\bconsult-agent\b/i, title: "E4 HR 特例分支" },
];

/** HR Provider 端口号特例（禁止生产分支）：匹配 8100 端口字面量。 */
const CLOSEOUT_PORT_PATTERN = /[:/]8100\b|port\s*[:=]\s*8100\b/i;

/**
 * 精确文件白名单（逐文件，绝不目录豁免）：
 * - hr-agent-contract.ts 是登记事实测试夹具（真实首个集成的公共合同副本），
 *   doc 08 §2 明确允许 fixture 存在，但其内容含 HR 标识。
 */
const CLOSEOUT_ALLOWLIST = new Set([
  "lib/agents/test-support/hr-agent-contract.ts",
  // Studio 测试夹具（DTO fixture，非生产构造；08 §2 fixture 可存在）。
  "components/studio/test-support/route-activation-fixtures.ts",
]);

export function collectCloseoutBoundaryViolations(
  documents: readonly SourceDocument[],
): Array<{ path: string; title: string }> {
  const seen = new Set<string>();
  const violations: Array<{ path: string; title: string }> = [];
  for (const document of documents) {
    const path = document.path;
    if (!TOPIC01_SCOPE.test(path)) continue;
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    if (TOPIC01_RULE_DEFINITIONS.has(path)) continue;
    if (CLOSEOUT_ALLOWLIST.has(path)) continue;
    const source = stripComments(document.source);
    for (const rule of [
      ...CLOSEOUT_BOUNDARY_PATTERNS,
      { pattern: CLOSEOUT_PORT_PATTERN, title: "E4 HR 特例分支（8100 端口）" },
    ]) {
      if (rule.pattern.test(source)) {
        const key = `${rule.title}:${path}`;
        if (!seen.has(key)) {
          seen.add(key);
          violations.push({ path, title: rule.title });
        }
      }
    }
  }
  return violations;
}

// ─── Resume Gate（08 §5）────────────────────────────────────

const RESOLVE_ROUTE_PATH =
  "app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route.ts";
const A2A_TRANSPORT_PATH = "lib/agents/calls/transport/a2a/a2a-client.ts";

export interface ResumeGateResult {
  passed: boolean;
  failures: string[];
}

export function checkResumeTruthfulnessGate(
  documents: readonly SourceDocument[],
): ResumeGateResult {
  const failures: string[] = [];
  const resolveRoute = documents.find((item) => item.path === RESOLVE_ROUTE_PATH);
  if (!resolveRoute) {
    failures.push(`${RESOLVE_ROUTE_PATH} 不存在`);
  } else {
    // Resume dispatch 不得 .catch 吞错后无条件 200。
    if (/dispatchResumeCommandToRuntime[\s\S]{0,400}?\.catch\s*\(/.test(resolveRoute.source)) {
      failures.push("resolve route 对 dispatchResumeCommandToRuntime 使用 .catch 吞掉结果");
    }
    // 响应必须携带唯一 Authority resume_dispatch（真实 Gateway 结果）。
    if (!resolveRoute.source.includes("resume_dispatch")) {
      failures.push("resolve route 缺少 resume_dispatch 真实调度结果投影");
    }
  }
  const transport = documents.find((item) => item.path === A2A_TRANSPORT_PATH);
  if (!transport) {
    failures.push(`${A2A_TRANSPORT_PATH} 不存在`);
  } else {
    // Agent transport resumeCall 必须使用公共 metadata mapper（04 §12）。
    const resumeIndex = transport.source.indexOf("async resumeCall");
    const resumeSlice =
      resumeIndex >= 0 ? transport.source.slice(resumeIndex, resumeIndex + 3000) : "";
    if (!resumeSlice.includes("buildA2APublicMessageMetadata")) {
      failures.push("a2a-client.resumeCall 未使用公共 metadata mapper");
    }
  }
  return { passed: failures.length === 0, failures };
}

// ─── 九项问题最终收口（V12/01 08 专项）Gate F1-F8 ────────────

/**
 * F1-F8：九项问题收口红线（生产作用域，按精确文件做结构性检查）：
 * - F1 Fake retry：command-dispatcher transient 分支必须排定 durable retry；
 *   dispatcher/Attempt 服务的 transient 分支必须产生/更新 queued Attempt retry work。
 * - F2 Recovery global-db leak：markInvocationLost 事务内必须使用 caller-owned
 *   SessionBinding 版本（markSessionBindingLostInSession），禁止全局 db 版本。
 * - F5 Resume dispatched=false：resolve route 必须显式 switch 三种 reason，
 *   禁止 if(!dispatched) local 200 一把梭。
 * - F6 Capability hardcode：A2A Start response 不得硬编码 cancel/resume/user_action=true，
 *   必须投影 params.capabilities。
 * - F7 Contract invalid combo：Parser 必须包含 input_required=true → resume=true。
 */
export interface NineIssueCloseoutGateResult {
  passed: boolean;
  failures: string[];
}

function docOrFail(
  documents: readonly SourceDocument[],
  path: string,
  failures: string[],
): SourceDocument | null {
  const document = documents.find((item) => item.path === path);
  if (!document) {
    failures.push(`${path} 不存在`);
    return null;
  }
  return document;
}

export function checkNineIssueCloseoutGate(
  documents: readonly SourceDocument[],
): NineIssueCloseoutGateResult {
  const failures: string[] = [];

  // F1 Fake retry
  const commandDispatcher = docOrFail(documents, "lib/runtime/command-dispatcher.ts", failures);
  if (commandDispatcher) {
    if (!commandDispatcher.source.includes("scheduleCommandTransientRetry")) {
      failures.push("F1 command-dispatcher transient 分支未调用 scheduleCommandTransientRetry");
    }
  }
  const dispatcher = docOrFail(documents, "lib/runtime/dispatcher.ts", failures);
  if (dispatcher) {
    if (!dispatcher.source.includes("recordAttemptDispatchTransientFailure")) {
      failures.push("F1 dispatcher transient 分支未调用 recordAttemptDispatchTransientFailure");
    }
  }
  const attemptService = docOrFail(
    documents,
    "lib/runtime/retry/dispatch-queued-invocation-attempt.ts",
    failures,
  );
  if (attemptService && !attemptService.source.includes("recordAttemptDispatchTransientFailure")) {
    failures.push("F1 Attempt dispatch 服务 transient 分支未排定 durable retry");
  }

  // F2 Recovery global-db leak
  const recovery = docOrFail(documents, "lib/runtime/recovery-queries.ts", failures);
  if (recovery) {
    if (!recovery.source.includes("markSessionBindingLostInSession")) {
      failures.push("F2 markInvocationLost 未使用 caller-owned markSessionBindingLostInSession");
    }
    if (/import\s*\{[^}]*\bmarkSessionBindingLost\b[^}]*\}\s*from/.test(recovery.source)) {
      failures.push("F2 recovery-queries import 了全局 db 版本 markSessionBindingLost");
    }
  }

  // F5 Resume dispatched=false 显式 switch
  const resolveRoute = docOrFail(
    documents,
    "app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route.ts",
    failures,
  );
  if (resolveRoute) {
    for (const reason of ["protocol_not_remote", "unsupported_capability", "command_not_found"]) {
      if (!resolveRoute.source.includes(reason)) {
        failures.push(`F5 resolve route 缺少 ${reason} 显式分支`);
      }
    }
    const source = stripComments(resolveRoute.source);
    if (/!gatewayResult\.dispatched[\s\S]{0,200}local_runtime/.test(source)) {
      // 唯一 local_runtime 语义只允许 protocol_not_remote 分支
      const m = /if\s*\(\s*gatewayResult\.reason\s*===\s*["']protocol_not_remote["']\s*\)/.test(
        source,
      );
      const blindLocal = /else\s*\{[^}]{0,400}mode:\s*["']local_runtime["']/.test(source);
      if (!m || blindLocal) {
        failures.push("F5 resolve route 存在非 protocol_not_remote 的 local_runtime 兜底分支");
      }
    }
  }

  // F6 Capability hardcode：Start response 投影
  const transport = docOrFail(documents, "lib/agents/calls/transport/a2a/a2a-client.ts", failures);
  if (transport) {
    const source = stripComments(transport.source);
    if (
      /cancel:\s*true\b/.test(source) ||
      /resume:\s*true\b/.test(source) ||
      /user_action:\s*true\b/.test(source)
    ) {
      failures.push("F6 Agent transport 硬编码 cancel/resume/user_action=true");
    }
    if (!source.includes("params.capabilities.cancel")) {
      failures.push("F6 Start response 未投影冻结 params.capabilities");
    }
  }

  // F7 Contract invalid combo
  const parser = docOrFail(documents, "lib/agents/domain/public-agent-contract.ts", failures);
  if (
    parser &&
    !parser.source.includes("interaction.input_required=true 要求 interaction.resume=true")
  ) {
    failures.push("F7 Parser 缺少 input_required=true → resume=true 语义约束");
  }

  return { passed: failures.length === 0, failures };
}

// ─── Batch9 最终收口 Gate（V12/01 方案 §四 15 条红线）────────────

/**
 * Batch9 最终架构红线：冻结架构下旧 Authority 不得重新出现。
 *
 * 全部检查剥离注释，排除 .test.* 与规则定义文件，逐文件精确匹配（不目录豁免）。
 *
 * 覆盖（§四 缺失项）：
 * - R1 ExecutionBinding/RuntimeSessionBinding schema 不得出现 Agent evidence 列。
 * - R2 RuntimeRevision schema 不得出现 Agent/A2A contract authority 字段。
 * - R3 Runtime Start Request 不得出现 agent execution target / agent_instruction_ref。
 * - R4 不得出现 HostedAgentLoop。
 * - R5 顶层 ThreadItem 不得恢复 agent_message。
 * - R6 只能有一个 Route Resolver（禁第二套 resolveHarnessRoute/resolveAgentRoute 等）。
 * - R7 AgentCall 必须作为 child domain 存在（parentInvocationId 恒必填）。
 * - R8 A2A lifecycle 必须落到 AgentCall，不得直接改 parent Invocation 终态。
 */
export interface Topic01FinalCloseoutGateResult {
  passed: boolean;
  failures: string[];
}

const FINAL_SCOPE = /^(app|components|desktop|lib|scripts)\//;

/** 规则定义文件自身（含检测正则/说明文字），按文件精确排除。 */
const FINAL_RULE_DEFINITIONS = new Set([
  "scripts/architecture-gate.ts",
  "scripts/architecture-gate-rules.ts",
]);

/**
 * ExecutionBinding / RuntimeSessionBinding 表（lib/persistence/schema/executions.ts）
 * 禁止出现任何 Agent evidence 列名（§四 #3/#4）。
 */
const EXECUTION_SCHEMA_PATH = "lib/persistence/schema/executions.ts";
const EXECUTION_AGENT_COLUMNS =
  /\bagentRevisionId\b|\bagentContractSnapshotId\b|\bagentContractDigest\b|\bagentContextDigest\b|\bagentPublicationRecordId\b|\bagentCapabilityDigest\b/;

/**
 * RuntimeRevision 表（lib/persistence/schema/runtimes.ts）禁止出现
 * Agent/A2A contract authority 字段（§四 #5）。
 */
const RUNTIME_SCHEMA_PATH = "lib/persistence/schema/runtimes.ts";
const RUNTIME_AGENT_AUTHORITY =
  /\bagentContractSnapshotId\b|\bverificationState\b|\bevidenceDigest\b/;

/**
 * Runtime Start Request（lib/runtime/runtime-client.ts）禁止出现
 * agent execution target / agent_instruction_ref / Agent model-permission-interface
 * 下发字段（§四 #8）。允许 capability_requirements[type=agent]。
 */
const START_REQUEST_PATH = "lib/runtime/runtime-client.ts";
const START_REQUEST_AGENT_TARGET =
  /\bagent_instruction_ref\b|\bmodel_policy\b|\bpermission_requirements\b|\binterface_requirements\b/;

/** 全仓标识符级禁词（生产 scope，剥离注释）。 */
const FINAL_IDENTIFIER_PATTERNS: ReadonlyArray<{ pattern: RegExp; title: string }> = [
  { pattern: /\bHostedAgentLoop\b/, title: "R4 HostedAgentLoop 旧 Loop 命名" },
  {
    pattern: /\bresolveHarnessRoute\b|\bresolveAgentRoute\b/,
    title: "R6 第二套 Route Resolver 命令",
  },
  {
    pattern: /\bAgentRouteResolver\b|\bRuntimeRouteResolver\b|\bHarnessRouteResolver\b/,
    title: "R6 第二套 Resolver Authority",
  },
  { pattern: /["']agent_message["']/, title: "R5 顶层 ThreadItem agent_message" },
];

/** AgentCall child domain 文件必须存在且恒含 parentInvocationId（§四 #13）。 */
const AGENT_CALL_DOMAIN_PATH = "lib/agents/calls/domain/agent-call.ts";
const AGENT_CALL_SCHEMA_PATH = "lib/persistence/schema/agent-calls.ts";

/**
 * A2A lifecycle 归属（§四 #14）：Agent transport 不得直接改 parent Invocation 终态。
 * 要求 A2A transport 目录内生产代码不得出现对 parent Invocation / 顶层 Turn 终态的
 * 直接写入标记；统一通过 AgentCall 事件归一化（a2a-mapper 注释声明该约束）。
 */
const A2A_TRANSPORT_SCOPE = /^lib\/agents\/calls\/transport\//;
const A2A_PARENT_WRITE_FORBIDDEN =
  /\bmarkInvocationLost\b|\bmarkInvocationCompleted\b|\bmarkTurnCompleted\b|\bRuntimeEventIngress\b/;

export function checkTopic01FinalCloseoutGate(
  documents: readonly SourceDocument[],
): Topic01FinalCloseoutGateResult {
  const failures: string[] = [];

  for (const document of documents) {
    const path = document.path;
    if (!FINAL_SCOPE.test(path)) continue;
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    if (FINAL_RULE_DEFINITIONS.has(path)) continue;
    const source = stripComments(document.source);

    // R1：ExecutionBinding / RuntimeSessionBinding schema 无 Agent evidence 列。
    if (path === EXECUTION_SCHEMA_PATH && EXECUTION_AGENT_COLUMNS.test(source)) {
      failures.push("R1 ExecutionBinding/RuntimeSessionBinding schema 出现 Agent evidence 列");
    }
    // R2：RuntimeRevision schema 无 Agent/A2A contract authority。
    if (path === RUNTIME_SCHEMA_PATH && RUNTIME_AGENT_AUTHORITY.test(source)) {
      failures.push("R2 RuntimeRevision schema 出现 Agent/A2A contract authority 字段");
    }
    // R3：Runtime Start Request 无 agent execution target。
    if (path === START_REQUEST_PATH && START_REQUEST_AGENT_TARGET.test(source)) {
      failures.push("R3 Runtime Start Request 出现 agent execution target / 下发字段");
    }
    // R4/R5/R6：全仓标识符禁词。
    for (const rule of FINAL_IDENTIFIER_PATTERNS) {
      if (rule.pattern.test(source)) {
        failures.push(rule.title);
      }
    }
    // R8：A2A transport 不得直接改 parent Invocation 终态。
    if (A2A_TRANSPORT_SCOPE.test(path) && A2A_PARENT_WRITE_FORBIDDEN.test(source)) {
      failures.push("R8 A2A transport 直接修改 parent Invocation 终态");
    }
  }

  // R7：AgentCall child domain 存在且 parentInvocationId 恒必填。
  const agentCallDomain = documents.find((item) => item.path === AGENT_CALL_DOMAIN_PATH);
  if (!agentCallDomain) {
    failures.push("R7 AgentCall domain 不存在（lib/agents/calls/domain/agent-call.ts）");
  } else if (!agentCallDomain.source.includes("parentInvocationId")) {
    failures.push("R7 AgentCall domain 缺少 parentInvocationId（未作为 child Invocation）");
  }
  const agentCallSchema = documents.find((item) => item.path === AGENT_CALL_SCHEMA_PATH);
  if (!agentCallSchema) {
    failures.push("R7 AgentCall schema 不存在（lib/persistence/schema/agent-calls.ts）");
  } else if (!stripComments(agentCallSchema.source).includes("parentInvocationId")) {
    failures.push("R7 AgentCall schema 缺少 parentInvocationId 列");
  }

  return { passed: failures.length === 0, failures };
}
