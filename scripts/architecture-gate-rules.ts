/**
 * Architecture Gate 的 deprecated/legacy 检查纯规则模块。
 *
 * 业务不变量：/test-support/ 不因路径整体豁免——只允许 .test.ts/.test.tsx 与
 * 显式精确文件白名单跳过。本模块接收 SourceDocument 数组，返回违规路径数组，
 * 保持输入顺序并去重。scope 与禁词语义与 architecture-gate.ts 原有
 * checkDeprecatedArchitecture 一致，抽取为可单测的纯函数。
 */

/** Agent/Runtime/Route Authority 及其正式消费者。 */
const AUTHORITY_SOURCE_SCOPE =
  /^(lib\/(agents|artifacts|control-plane|executions|publications|routes|runtime)\/|lib\/persistence\/schema\/(agents|agent-calls|runtimes|executions|deployment-route|conversation|projection)\.ts$|app\/(admin\/api\/v1\/(agents|agent-revisions|deployment-route)|gateway\/v1\/agent-calls|api\/v1\/(threads|turns)|runtime\/v1)\/|components\/(thread|studio\/(agent|route|runtime))|desktop\/renderer\/)/;

/** deprecated 禁词（大小写不敏感）：@deprecated、单词 legacy/cutover/shadow、fallback legacy。 */
const DEPRECATED_PATTERN = /@deprecated|\blegacy\b|\bcutover\b|fallback legacy/i;

/** 施工历史只能留在 docs，不能成为生产领域说明。 */
const IMPLEMENTATION_HISTORY_PATTERN =
  /docs\/V(?:11|12)\/01|专题0?1|\bBatch\s*\d+\b|\bPhase\s*[A-Z0-9]+\b|\bStage\s*[A-Z0-9]+\b|阶段\s*[0-9一二三四五六七八九十]+|关口\s*\d+|\bS\d{2}-[CW]\d{2}\b|(?:^|[\s（(])0[0-7]\s*§\s*[0-9一二三四五六七八九十]+/im;

/** 已物理删除的第二入口。测试可以写拒绝文本，但不能再依赖这些模块。 */
const RETIRED_MODULE_SPECIFIER =
  /(?:@\/|(?:\.\.\/)+)(?:lib\/runtime\/(?:.*\/)?a2a[^"']*|lib\/routes\/application\/(?:upsert|disable)-deployment-route|app\/api\/v1\/agents(?:\/route)?|lib\/agents\/(?:hosted-agent-publication|hosted-agent-route)[^"']*)/;

const MODULE_DEPENDENCY =
  /(?:from\s*|require\(\s*|import\(\s*|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s*)["']([^"']+)["']/g;

const RETIRED_AGENT_EXECUTION_PATTERN =
  /\b(?:resolveRequiredAgentBinding|RequiredAgentUnavailableError|invokeRequiredAgent)\b|harness-required-agent|required-agent/;

export interface SourceDocument {
  path: string;
  source: string;
}

/** 返回仍把施工历史写进 Agent/Runtime/Route 正式源码的文件。 */
export function collectImplementationHistoryViolations(
  documents: readonly SourceDocument[],
  allowlist: ReadonlySet<string> = new Set<string>(),
): string[] {
  const violations = new Set<string>();
  for (const document of documents) {
    if (!AUTHORITY_SOURCE_SCOPE.test(document.path)) continue;
    if (document.path.includes(".test.")) continue;
    if (allowlist.has(document.path)) continue;
    if (IMPLEMENTATION_HISTORY_PATTERN.test(document.source)) violations.add(document.path);
  }
  return [...violations];
}

/** 返回仍 import/require/export 已删除第二入口的源码，包括测试与 test-support。 */
export function collectRetiredModuleDependencyViolations(
  documents: readonly SourceDocument[],
): string[] {
  const violations = new Set<string>();
  for (const document of documents) {
    if (!/^(app|components|desktop|hooks|lib|scripts)\//.test(document.path)) continue;
    if (
      document.path === "scripts/architecture-gate-rules.ts" ||
      document.path === "scripts/architecture-gate-rules.test.ts"
    ) {
      continue;
    }
    MODULE_DEPENDENCY.lastIndex = 0;
    for (const match of document.source.matchAll(MODULE_DEPENDENCY)) {
      if (RETIRED_MODULE_SPECIFIER.test(match[1] ?? "")) violations.add(document.path);
    }
  }
  return [...violations];
}

/** 返回重新引入旧 Required-Agent 执行桥、符号或幂等前缀的源码。 */
export function collectRetiredAgentExecutionViolations(
  documents: readonly SourceDocument[],
): string[] {
  const violations = new Set<string>();
  for (const document of documents) {
    if (!/^(app|components|desktop|hooks|lib|scripts)\//.test(document.path)) continue;
    if (
      document.path === "scripts/architecture-gate-rules.ts" ||
      document.path === "scripts/architecture-gate-rules.test.ts"
    ) {
      continue;
    }
    if (RETIRED_AGENT_EXECUTION_PATTERN.test(stripComments(document.source))) {
      violations.add(document.path);
    }
  }
  return [...violations];
}

export interface AgentInvokeAuthorizationGateResult {
  passed: boolean;
  failures: string[];
}

export interface AgentCallFinalizationGateResult {
  passed: boolean;
  failures: string[];
}

export interface AgentCallRuntimeBoundaryGateResult {
  passed: boolean;
  failures: string[];
}

export interface AgentRevisionAuthorityGateResult {
  passed: boolean;
  failures: string[];
}

/** AgentRevision 是唯一版本轴，currentRevisionId 只作发布摘要。 */
export function checkAgentRevisionAuthorityGate(
  documents: readonly SourceDocument[],
): AgentRevisionAuthorityGateResult {
  const failures: string[] = [];
  const source = (path: string) =>
    documents.find((document) => document.path === path)?.source ?? "";
  const schema = source("lib/persistence/schema/agents.ts");
  const revisionQueries = stripComments(source("lib/agents/persistence/agent-revision-queries.ts"));
  const publication = stripComments(source("lib/agents/application/publish-agent-revision.ts"));

  if (
    !schema.includes("反规范化摘要") ||
    !schema.includes("Publication") ||
    !schema.includes("Route") ||
    !schema.includes("Projection") ||
    !schema.includes("Binding")
  ) {
    failures.push("Agent.currentRevisionId 未声明为非执行 Authority 的发布摘要");
  }
  if (
    !revisionQueries.includes("agentContractSnapshotTable") ||
    !revisionQueries.includes("params.tenantId") ||
    !revisionQueries.includes("snapshot.agentId !== params.agentId")
  ) {
    failures.push("AgentRevision 创建未原子校验 Snapshot 同 tenant + 同 Agent");
  }
  if (
    !publication.includes("recomputedContractDigest") ||
    !publication.includes("recomputedCapabilityDigest") ||
    !publication.includes("recomputedContextDigest")
  ) {
    failures.push("AgentRevision 发布前未验证结构化 ContractSnapshot 摘要");
  }

  for (const document of documents) {
    const path = document.path;
    const isTest = path.endsWith(".test.ts") || path.endsWith(".test.tsx");
    const isSupport = path.includes("/test/") || path.includes("/test-support/");
    const isAgentControlPlane =
      path === "lib/persistence/schema/agents.ts" ||
      path === "lib/control-plane-client/contracts/agent.ts" ||
      path.startsWith("lib/agents/") ||
      path.startsWith("app/admin/api/v1/agents/") ||
      path.startsWith("app/admin/api/v1/agent-revisions/") ||
      path.startsWith("app/gateway/v1/agent-calls/") ||
      path === "app/admin/api/v1/agents/route.ts" ||
      path === "app/gateway/v1/agent-calls/route.ts";
    if (!isAgentControlPlane || isTest || isSupport) continue;

    const productionSource = stripComments(document.source);
    const isExecutionPath =
      path.startsWith("lib/agents/calls/") ||
      path.startsWith("lib/routes/application/") ||
      path.startsWith("lib/routes/projection/");
    if (
      isExecutionPath &&
      /\bagent(?:Table)?\.currentRevisionId\b|\bAgent\.currentRevisionId\b/.test(productionSource)
    ) {
      failures.push(`Agent 执行路径读取 currentRevisionId：${path}`);
    }
    if (
      isExecutionPath &&
      /\b(?:getLatestPublishedRevision|getCurrentAgentRevision|latestAgentRevision)\b/.test(
        productionSource,
      )
    ) {
      failures.push(`Agent 执行路径仍含 latest/current revision fallback：${path}`);
    }
    if (/\bAgentContractRevision\b|\bContractPublication\b/.test(productionSource)) {
      failures.push(`Agent Contract 第二版本轴/发布 Authority 仍存在：${path}`);
    }
  }

  return { passed: failures.length === 0, failures: [...new Set(failures)] };
}

/** Harness 只映射一次 durable disposition；A2A outbound 仍归 AgentTransport。 */
export function checkAgentCallRuntimeBoundaryGate(
  documents: readonly SourceDocument[],
): AgentCallRuntimeBoundaryGateResult {
  const failures: string[] = [];
  const source = (path: string) =>
    stripComments(documents.find((document) => document.path === path)?.source ?? "");
  const harness = source("lib/agents/calls/application/agent-action-executor.ts");
  const start = source("lib/agents/calls/application/start-agent-call.ts");
  const hosted = source("lib/runtime/adapters/hosted-adapter.ts");

  if (!harness.includes("startAgentCall") || !harness.includes("toAgentCallDisposition")) {
    failures.push("Harness AgentCall bridge 未执行一次 start + durable disposition mapping");
  }
  if (
    /\b(?:MAX_WAIT_MS|POLL_INTERVAL_MS|pollTimeoutMs|waitForAgentCallTerminal)\b|\bset(?:Timeout|Interval)\s*\(|\bwhile\s*\(|\bfor\s*\(\s*;\s*;\s*\)|\bPromise\.race\s*\(/.test(
      harness,
    )
  ) {
    failures.push("Harness AgentCall bridge 仍包含同步轮询或 timeout 生命周期");
  }
  if (!start.includes("createA2AAgentTransport") || !start.includes("getById")) {
    failures.push("startAgentCall 未经唯一 AgentTransport 出站并回读 durable AgentCall");
  }
  if (
    /capabilityDirectives\??\.find[\s\S]{0,1200}\bagentCallExecutor\s*\(/.test(hosted) ||
    /preferredAgent[\s\S]{0,1200}\bagentCallExecutor\s*\(/.test(hosted)
  ) {
    failures.push("Hosted Harness 把 preferred directive 当成 AgentCall 执行要求");
  }

  for (const document of documents) {
    if (!document.path.startsWith("lib/runtime/")) continue;
    if (document.path.endsWith(".test.ts") || document.path.endsWith(".test.tsx")) continue;
    const productionSource = stripComments(document.source);
    if (
      /\bcreateA2AAgentTransport\b|agents\/calls\/transport\/a2a\/a2a-client/.test(productionSource)
    ) {
      failures.push(`Runtime 越权建立 Agent A2A outbound：${document.path}`);
    }
  }

  return { passed: failures.length === 0, failures: [...new Set(failures)] };
}

/** AgentCall 只能通过单一最终事务冻结，禁止旧幂等入口与假事实。 */
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
  const attemptDomain = stripComments(source("lib/agents/calls/domain/agent-call-attempt.ts"));

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
  const attemptSchema = schema
    .split("export const agentCallAttemptTable", 2)[1]
    ?.split("export type AgentCallAttempt", 1)[0];
  const callSchema = schema
    .split("export const agentCallTable", 2)[1]
    ?.split("export type AgentCall", 1)[0];
  if (
    callSchema?.includes("externalTaskRef") ||
    !attemptSchema?.includes("externalTaskRef") ||
    !attemptDomain.includes("externalTaskRef")
  ) {
    failures.push("AgentCall externalTaskRef 未唯一归属 AgentCallAttempt");
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
    if (!AUTHORITY_SOURCE_SCOPE.test(document.path)) continue;
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
 * Harness Agent Authority 边界规则的纯规则模块。
 *
 * 业务不变量（与 architecture-gate.ts 原有 checkHarnessAgentBoundaries 一致，抽取为
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
const ARCHITECTURE_SCOPE = /^(app|components|desktop|lib|scripts)\//;

/** 规则定义文件（含检测正则自身），按文件精确排除。 */
const ARCHITECTURE_RULE_DEFINITIONS = new Set([
  "scripts/architecture-gate.ts",
  "scripts/architecture-gate-rules.ts",
]);

/** CreateThread 正式 route：其可执行代码只要出现 agent_id 字段即违规。 */
const CREATE_THREAD_ROUTE = "app/api/v1/threads/route.ts";

/** Harness Agent 边界规则模式。 */
const HARNESS_AGENT_BOUNDARY_PATTERNS: ReadonlyArray<{ pattern: RegExp; title: string }> = [
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
    // RouteResolver 命令必须用显式 target:{kind:"runtime"|"agent"}，
    // 禁止用 agentConstraint 或 null 隐式表达目标。
    pattern: /\bagentConstraint\b/,
    title: "RouteResolver agentConstraint 隐式 target",
  },
  {
    // 仅禁止「agents.length===0 执行阻断」（return/throw，允许可选大括号）。
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

// ─── A2A AgentCall 边界 ───────────────────────────────────

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

/** 对外 RouteSet DTO 不得再用 flat nullable agent 字段表达目标。 */
const ROUTE_SET_CONTRACT_PATH = "lib/control-plane-client/contracts/route.ts";
const ROUTE_SET_NULLABLE_EXTERNAL_TARGET =
  /\b(?:agentId|agent_id)\??\s*:\s*(?:string\s*\|\s*null|null\s*\|\s*string)/;

/** 不得根据 agentId 的真假/null 反推 Route target。 */
const ROUTE_TARGET_NULL_INFERENCE =
  /(?:(?:const|let|var)\s+\w*[Tt]arget\w*\s*=|return)\s*(?:\w+\.)?\b(?:agentId|agent_id)\b\s*\?[^;\n]{0,200}\bkind\s*:\s*["'](?:runtime|agent)["']/;

const ROUTE_ACTIVATION_STORE_PATH = "lib/routes/persistence/mysql-route-set-activation-store.ts";
const ROUTE_ELIGIBILITY_STORE_PATH = "lib/routes/projection/mysql-route-eligibility-store.ts";

/** Schema 已知 RUNTIME_PROTOCOL_TYPES 不得含 a2a（仅 schema 文件）。 */
const SCHEMA_RUNTIMES_PATH = "lib/persistence/schema/runtimes.ts";
const SCHEMA_PROTOCOL_A2A = /RUNTIME_PROTOCOL_TYPES\s*=\s*\[[^\]]*["']a2a["']/;

const B1_SCHEMA_PATH = "lib/db/schema.ts";
const B1_FORMAL_AUTHORITY =
  /\bTHREAD_STATUSES\b|\bTHREAD_EVENT_TYPES\b|\bMESSAGE_TYPES\b|from\s+["']@\/lib\/(?:persistence\/schema\/(?:agents|runtimes|executions|deployment-route|conversation|projection)|runtime\/persistence\/runtime-conformance-run-record)["']/;

const LOCAL_RUNTIME_RESOLVER_PATH = "lib/runtime/resolver.ts";
const THREAD_RUNTIME_SELECTION =
  /\bresolveRuntimeTypeForThread\b|\bthread\??\.runtimeType\b|\bskillVersion\??\.runtimeType\b/;

/** Runtime 生产 protocolType 赋值不得为 a2a（lib/runtime 下；AgentContractSnapshot 属 lib/agents 不受限）。 */
const RUNTIME_PROTOCOL_A2A = /protocolType\s*[:=]\s*["']a2a["']/;

/**
 * 收集 Harness Agent Authority 边界违规路径。
 *
 * 对每个在生产作用域内、非 .test.ts/.test.tsx、非规则定义文件的文档，剥离注释后
 * 匹配边界模式；命中任一规则即计入违规。返回唯一 path，保持输入顺序。
 *
 * @param documents 全部候选文档（含 test-support 与测试文件，规则自行过滤）。
 * @returns 违规 path，保持输入顺序、唯一。
 */
export function collectHarnessAgentBoundaryViolations(
  documents: readonly SourceDocument[],
): string[] {
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const document of documents) {
    const path = document.path;
    if (!ARCHITECTURE_SCOPE.test(path)) continue;
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    if (ARCHITECTURE_RULE_DEFINITIONS.has(path)) continue;
    const source = stripComments(document.source);
    let flagged = false;
    // CreateThread 正式 route：出现 agent_id 字段即违规（不区分 required/optional）。
    if (path === CREATE_THREAD_ROUTE && /\bagent_id\b/.test(source)) {
      flagged = true;
    }
    if (!flagged) {
      for (const rule of HARNESS_AGENT_BOUNDARY_PATTERNS) {
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
    if (
      !flagged &&
      path === ROUTE_SET_CONTRACT_PATH &&
      ROUTE_SET_NULLABLE_EXTERNAL_TARGET.test(source)
    ) {
      flagged = true;
    }
    if (!flagged && path.startsWith("lib/routes/") && ROUTE_TARGET_NULL_INFERENCE.test(source)) {
      flagged = true;
    }
    // RouteActivation 与 RouteEligibilityProjection 只能由各自唯一 Store 写入。
    if (
      !flagged &&
      path !== ROUTE_ACTIVATION_STORE_PATH &&
      /\.update\(\s*deploymentRouteTable\s*\)[\s\S]{0,300}?activeRouteRevisionId/.test(source)
    ) {
      flagged = true;
    }
    if (
      !flagged &&
      path !== ROUTE_ELIGIBILITY_STORE_PATH &&
      /\.(?:insert|update|delete)\(\s*routeEligibilityProjection(?:Table)?\s*\)/.test(source)
    ) {
      flagged = true;
    }
    // ── A2A AgentCall 边界 ──
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
    // B1 聚合层不再暴露 Thread/Message 执行状态或转出正式 Authority Schema。
    if (!flagged && path === B1_SCHEMA_PATH && B1_FORMAL_AUTHORITY.test(source)) {
      flagged = true;
    }
    // 本地预览 Runtime 只能读取平台配置，不得恢复 Thread/Skill Runtime 选择轴。
    if (!flagged && path === LOCAL_RUNTIME_RESOLVER_PATH && THREAD_RUNTIME_SELECTION.test(source)) {
      flagged = true;
    }
    if (flagged && !seen.has(path)) {
      seen.add(path);
      violations.push(path);
    }
  }
  return violations;
}

// ─── Execution wire 与特例分支边界 ────────────────────────

/**
 * 生产作用域在剥离注释后必须满足：
 * - A2A external production wire 不得出现 snowharness.execution_subject；
 * - 公共 subject 映射不得输出裸 "service"（必须 platform_service）；
 * - Studio production 不得自行构造 conformance_run_id 字面量（只能来自 DTO）；
 * - 生产代码不得有 HR-specific runtime branch。
 */
const EXECUTION_BOUNDARY_PATTERNS: ReadonlyArray<{ pattern: RegExp; title: string }> = [
  { pattern: /snowharness\.execution_subject/, title: "namespaced execution_subject wire" },
  {
    // 捕获直接赋值与三元输出映射（"platform_service" 因引号边界不匹配）；
    // === / !== / < / > 后的 "service" 是比较而非输出，可变长 lookbehind 排除。
    pattern: /subject_kind\s*[:=][^;\n]{0,60}(?<![=!<>]\s*)["']service["']/,
    title: "subject_kind 裸 service 输出",
  },
  {
    // 仅捕获对象字面量/赋值中的 run id 字符串字面量（=== 比较不匹配）。
    pattern: /conformance_run_id\s*:\s*["'][A-Za-z0-9][A-Za-z0-9_-]*["']/,
    title: "Studio/生产自行构造 conformance_run_id 字面量",
  },
  { pattern: /\bhr-assistant\b/i, title: "HR 特例分支" },
  { pattern: /\bveadk\b/i, title: "HR 特例分支" },
  { pattern: /\bagentkit\b/i, title: "HR 特例分支" },
  { pattern: /\bemployee-data\b/i, title: "HR 特例分支" },
  { pattern: /\bconsult-agent\b/i, title: "HR 特例分支" },
];

/** HR Provider 端口号特例（禁止生产分支）：匹配 8100 端口字面量。 */
const HR_PROVIDER_PORT_PATTERN = /[:/]8100\b|port\s*[:=]\s*8100\b/i;

/**
 * 精确文件白名单（逐文件，绝不目录豁免）：
 * - hr-agent-contract.ts 是登记事实测试夹具，其内容含 HR 标识。
 */
const EXECUTION_BOUNDARY_ALLOWLIST = new Set([
  "lib/agents/test-support/hr-agent-contract.ts",
  // Studio DTO 测试夹具，非生产构造。
  "components/studio/test-support/route-activation-fixtures.ts",
]);

export function collectExecutionBoundaryViolations(
  documents: readonly SourceDocument[],
): Array<{ path: string; title: string }> {
  const seen = new Set<string>();
  const violations: Array<{ path: string; title: string }> = [];
  for (const document of documents) {
    const path = document.path;
    if (!ARCHITECTURE_SCOPE.test(path)) continue;
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    if (ARCHITECTURE_RULE_DEFINITIONS.has(path)) continue;
    if (EXECUTION_BOUNDARY_ALLOWLIST.has(path)) continue;
    const source = stripComments(document.source);
    for (const rule of [
      ...EXECUTION_BOUNDARY_PATTERNS,
      { pattern: HR_PROVIDER_PORT_PATTERN, title: "HR 特例分支（8100 端口）" },
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

// ─── Resume 结果真实性 ────────────────────────────────────

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
    // Agent transport resumeCall 必须使用公共 metadata mapper。
    const resumeIndex = transport.source.indexOf("async resumeCall");
    const resumeSlice =
      resumeIndex >= 0 ? transport.source.slice(resumeIndex, resumeIndex + 3000) : "";
    if (!resumeSlice.includes("buildA2APublicMessageMetadata")) {
      failures.push("a2a-client.resumeCall 未使用公共 metadata mapper");
    }
  }
  return { passed: failures.length === 0, failures };
}

// ─── Dispatch 与 Recovery Authority ───────────────────────

/**
 * 生产作用域按精确文件检查以下职责：
 * - command-dispatcher transient 分支必须排定 durable retry；
 *   dispatcher/Attempt 服务的 transient 分支必须产生/更新 queued Attempt retry work。
 * - markInvocationLost 事务内必须使用 caller-owned
 *   SessionBinding 版本（markSessionBindingLostInSession），禁止全局 db 版本。
 * - Resume dispatched=false 时 resolve route 必须显式 switch 三种 reason，
 *   禁止 if(!dispatched) local 200 一把梭。
 * - A2A Start response 不得硬编码 cancel/resume/user_action=true，
 *   必须投影 params.capabilities。
 * - Parser 必须包含 input_required=true → resume=true。
 */
export interface DispatchRecoveryAuthorityGateResult {
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

export function checkDispatchRecoveryAuthorityGate(
  documents: readonly SourceDocument[],
): DispatchRecoveryAuthorityGateResult {
  const failures: string[] = [];

  // Durable retry ownership
  const commandDispatcher = docOrFail(documents, "lib/runtime/command-dispatcher.ts", failures);
  if (commandDispatcher) {
    if (!commandDispatcher.source.includes("scheduleCommandTransientRetry")) {
      failures.push("command-dispatcher transient 分支未调用 scheduleCommandTransientRetry");
    }
  }
  const dispatcher = docOrFail(documents, "lib/runtime/dispatcher.ts", failures);
  if (dispatcher) {
    if (!dispatcher.source.includes("recordAttemptDispatchTransientFailure")) {
      failures.push("dispatcher transient 分支未调用 recordAttemptDispatchTransientFailure");
    }
  }
  const attemptService = docOrFail(
    documents,
    "lib/runtime/retry/dispatch-queued-invocation-attempt.ts",
    failures,
  );
  if (attemptService && !attemptService.source.includes("recordAttemptDispatchTransientFailure")) {
    failures.push("Attempt dispatch 服务 transient 分支未排定 durable retry");
  }

  // Recovery transaction ownership
  const recovery = docOrFail(documents, "lib/runtime/recovery-queries.ts", failures);
  if (recovery) {
    if (!recovery.source.includes("markSessionBindingLostInSession")) {
      failures.push("markInvocationLost 未使用 caller-owned markSessionBindingLostInSession");
    }
    if (/import\s*\{[^}]*\bmarkSessionBindingLost\b[^}]*\}\s*from/.test(recovery.source)) {
      failures.push("recovery-queries import 了全局 db 版本 markSessionBindingLost");
    }
  }

  // Resume dispatched=false 显式 switch
  const resolveRoute = docOrFail(
    documents,
    "app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route.ts",
    failures,
  );
  if (resolveRoute) {
    for (const reason of ["protocol_not_remote", "unsupported_capability", "command_not_found"]) {
      if (!resolveRoute.source.includes(reason)) {
        failures.push(`resolve route 缺少 ${reason} 显式分支`);
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
        failures.push("resolve route 存在非 protocol_not_remote 的 local_runtime 兜底分支");
      }
    }
  }

  // Start response capability projection
  const transport = docOrFail(documents, "lib/agents/calls/transport/a2a/a2a-client.ts", failures);
  if (transport) {
    const source = stripComments(transport.source);
    if (
      /cancel:\s*true\b/.test(source) ||
      /resume:\s*true\b/.test(source) ||
      /user_action:\s*true\b/.test(source)
    ) {
      failures.push("Agent transport 硬编码 cancel/resume/user_action=true");
    }
    if (!source.includes("params.capabilities.cancel")) {
      failures.push("Start response 未投影冻结 params.capabilities");
    }
  }

  // Contract capability implication
  const parser = docOrFail(documents, "lib/agents/domain/public-agent-contract.ts", failures);
  if (
    parser &&
    !parser.source.includes("interaction.input_required=true 要求 interaction.resume=true")
  ) {
    failures.push("Parser 缺少 input_required=true → resume=true 语义约束");
  }

  return { passed: failures.length === 0, failures };
}

// ─── Agent execution Authority ────────────────────────────

/**
 * Agent execution Authority 必须保持与 Harness Runtime 分离。
 *
 * 全部检查剥离注释，排除 .test.* 与规则定义文件，逐文件精确匹配（不目录豁免）。
 *
 * 覆盖 ExecutionBinding、RuntimeRevision、Runtime Start Request、Hosted Runtime、
 * ThreadItem、Route Resolver、AgentCall child domain 与 A2A lifecycle 的 Authority 边界。
 */
export interface AgentExecutionAuthorityGateResult {
  passed: boolean;
  failures: string[];
}

const AGENT_EXECUTION_SCOPE = /^(app|components|desktop|lib|scripts)\//;

/** 规则定义文件自身（含检测正则/说明文字），按文件精确排除。 */
const AGENT_EXECUTION_RULE_DEFINITIONS = new Set([
  "scripts/architecture-gate.ts",
  "scripts/architecture-gate-rules.ts",
]);

/**
 * ExecutionBinding / RuntimeSessionBinding 表（lib/persistence/schema/executions.ts）
 * 禁止出现任何 Agent evidence 列名。
 */
const EXECUTION_SCHEMA_PATH = "lib/persistence/schema/executions.ts";
const EXECUTION_AGENT_COLUMNS =
  /\bagentRevisionId\b|\bagentContractSnapshotId\b|\bagentContractDigest\b|\bagentContextDigest\b|\bagentPublicationRecordId\b|\bagentCapabilityDigest\b/;

/**
 * RuntimeRevision 表（lib/persistence/schema/runtimes.ts）禁止出现
 * Agent/A2A contract authority 字段。
 */
const RUNTIME_SCHEMA_PATH = "lib/persistence/schema/runtimes.ts";
const RUNTIME_AGENT_AUTHORITY =
  /\bagentContractSnapshotId\b|\bverificationState\b|\bevidenceDigest\b/;

/**
 * Runtime Start Request（lib/runtime/runtime-client.ts）禁止出现
 * agent execution target / agent_instruction_ref / Agent model-permission-interface
 * 下发字段。允许 capability_directives[type=agent,mode=preferred]。
 */
const START_REQUEST_PATH = "lib/runtime/runtime-client.ts";
const START_REQUEST_AGENT_TARGET =
  /\bagent_instruction_ref\b|\bmodel_policy\b|\bpermission_requirements\b|\binterface_requirements\b/;

/** Runtime start DTO/调用方不得携带 AgentRevision 占位或选择字段。 */
const RUNTIME_START_AGENT_REVISION = /\bagentRevisionId\??\s*:/;

/** 协议收口后，Turn 与 Runtime 通道只允许 AgentUseDirective(preferred)。 */
const LEGACY_AGENT_SELECTION_PROTOCOL =
  /\bcapability_requirements\b|\bcapabilityRequirements\b|\brequested_agent_id\b|\brequestedAgentId\b|\bagentSelectionMode\b|["']agent_selection["']/;

/** 全仓标识符级禁词（生产 scope，剥离注释）。 */
const AGENT_EXECUTION_FORBIDDEN_IDENTIFIERS: ReadonlyArray<{ pattern: RegExp; title: string }> = [
  { pattern: /\bHostedAgentLoop\b/, title: "HostedAgentLoop 执行形态" },
  {
    pattern: /\bresolveHarnessRoute\b|\bresolveAgentRoute\b/,
    title: "第二套 Route Resolver 命令",
  },
  {
    pattern:
      /\bAgentRouteResolver\b|\bRuntimeRouteResolver\b|\bHarnessRouteResolver\b|\bShadowRouteResolver\b|\bAlternateRouteResolver\b|\bresolveShadowRoute\b|\bresolveAlternateRoute\b/,
    title: "第二套 Resolver Authority",
  },
  { pattern: /["']agent_message["']/, title: "顶层 ThreadItem agent_message" },
];

/** AgentCall child domain 文件必须存在且恒含 parentInvocationId。 */
const AGENT_CALL_DOMAIN_PATH = "lib/agents/calls/domain/agent-call.ts";
const AGENT_CALL_SCHEMA_PATH = "lib/persistence/schema/agent-calls.ts";

/**
 * A2A lifecycle 归属：Agent transport 不得直接改 parent Invocation 终态。
 * 要求 A2A transport 目录内生产代码不得出现对 parent Invocation / 顶层 Turn 终态的
 * 直接写入标记；统一通过 AgentCall 事件归一化（a2a-mapper 注释声明该约束）。
 */
const A2A_TRANSPORT_SCOPE = /^lib\/agents\/calls\/transport\//;
const A2A_PARENT_WRITE_FORBIDDEN =
  /\bmarkInvocationLost\b|\bmarkInvocationCompleted\b|\bmarkTurnCompleted\b|\bRuntimeEventIngress\b/;

export function checkAgentExecutionAuthorityGate(
  documents: readonly SourceDocument[],
): AgentExecutionAuthorityGateResult {
  const failures: string[] = [];

  for (const document of documents) {
    const path = document.path;
    if (!AGENT_EXECUTION_SCOPE.test(path)) continue;
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    if (AGENT_EXECUTION_RULE_DEFINITIONS.has(path)) continue;
    const source = stripComments(document.source);

    // ExecutionBinding / RuntimeSessionBinding schema 无 Agent evidence 列。
    if (path === EXECUTION_SCHEMA_PATH && EXECUTION_AGENT_COLUMNS.test(source)) {
      failures.push("ExecutionBinding/RuntimeSessionBinding schema 出现 Agent evidence 列");
    }
    // RuntimeRevision schema 无 Agent/A2A contract authority。
    if (path === RUNTIME_SCHEMA_PATH && RUNTIME_AGENT_AUTHORITY.test(source)) {
      failures.push("RuntimeRevision schema 出现 Agent/A2A contract authority 字段");
    }
    // Runtime Start Request 无 agent execution target。
    if (path === START_REQUEST_PATH && START_REQUEST_AGENT_TARGET.test(source)) {
      failures.push("Runtime Start Request 出现 agent execution target / 下发字段");
    }
    if (
      (path === START_REQUEST_PATH ||
        path === "lib/runtime/application/build-runtime-start-request.ts" ||
        path.startsWith("app/runtime/")) &&
      RUNTIME_START_AGENT_REVISION.test(source)
    ) {
      failures.push(`Runtime start 通道出现 agentRevisionId：${path}`);
    }
    if (LEGACY_AGENT_SELECTION_PROTOCOL.test(source)) {
      failures.push(`旧 Agent 选择协议重新出现：${path}`);
    }
    // 全仓被禁执行标识符。
    for (const rule of AGENT_EXECUTION_FORBIDDEN_IDENTIFIERS) {
      if (rule.pattern.test(source)) {
        failures.push(rule.title);
      }
    }
    // A2A transport 不得直接改 parent Invocation 终态。
    if (A2A_TRANSPORT_SCOPE.test(path) && A2A_PARENT_WRITE_FORBIDDEN.test(source)) {
      failures.push("A2A transport 直接修改 parent Invocation 终态");
    }
  }

  // AgentCall child domain 存在且 parentInvocationId 恒必填。
  const agentCallDomain = documents.find((item) => item.path === AGENT_CALL_DOMAIN_PATH);
  if (!agentCallDomain) {
    failures.push("AgentCall domain 不存在（lib/agents/calls/domain/agent-call.ts）");
  } else if (!agentCallDomain.source.includes("parentInvocationId")) {
    failures.push("AgentCall domain 缺少 parentInvocationId（未作为 child Invocation）");
  }
  const agentCallSchema = documents.find((item) => item.path === AGENT_CALL_SCHEMA_PATH);
  if (!agentCallSchema) {
    failures.push("AgentCall schema 不存在（lib/persistence/schema/agent-calls.ts）");
  } else if (!stripComments(agentCallSchema.source).includes("parentInvocationId")) {
    failures.push("AgentCall schema 缺少 parentInvocationId 列");
  }

  return { passed: failures.length === 0, failures };
}

// ─── Topic 01 final closure boundaries ────────────────────

export interface FinalClosureTestEntry {
  file: string;
  group: string;
}

export interface FinalClosureBoundaryGateResult {
  passed: boolean;
  failures: string[];
}

/**
 * 最终封版边界：只覆盖 Topic 01 冻结项，不扩张为全仓风格检查。
 */
export function checkFinalClosureBoundaryGate(
  documents: readonly SourceDocument[],
  canonicalSchemaFiles: ReadonlySet<string>,
  testCollection: readonly FinalClosureTestEntry[],
): FinalClosureBoundaryGateResult {
  const failures: string[] = [];
  const source = (path: string) =>
    documents.find((document) => document.path === path)?.source ?? "";

  for (const document of documents) {
    if (document.path.includes(".test.") || document.path.includes("/test-support/")) continue;
    if (AGENT_EXECUTION_RULE_DEFINITIONS.has(document.path)) continue;
    const production = stripComments(document.source);
    if (production.includes("mysqlTable(") && !canonicalSchemaFiles.has(document.path)) {
      failures.push(`第二 Schema Root/未登记表声明：${document.path}`);
    }
    if (
      document.path !== "lib/agents/calls/persistence/apply-agent-call-transition.ts" &&
      /\.update\(\s*agentCallTable\s*\)/.test(production)
    ) {
      failures.push(`AgentCall 状态被非授权模块直接写入：${document.path}`);
    }
  }

  const dbClient = stripComments(source("lib/db/client.ts"));
  if (!dbClient.includes('import * as schema from "@/lib/persistence/schema"')) {
    failures.push("Runtime 未从 Canonical Schema Root 加载");
  }
  if (/from\s+["']@\/lib\/(?:db\/schema|persistence\/schema\/[^"']+)["']/.test(dbClient)) {
    failures.push("Runtime 从非 Canonical Schema 导入");
  }

  const executors = stripComments(source("lib/runtime/harness-loop/platform-action-executors.ts"));
  if (!/["']tool\.call["']\s*:\s*createToolActionExecutor\(/.test(executors)) {
    failures.push("生产 Harness 工厂缺少 tool.call Executor");
  }

  const gateway = stripComments(source("app/gateway/v1/capability-actions/route.ts"));
  if (!gateway.includes("recoverTrustedExecutionSubject(binding, principal.tenantId)")) {
    failures.push("External Capability Gateway 未从 Binding 恢复可信 Subject");
  }
  if (/executionSubject\s*=\s*\{/.test(gateway)) {
    failures.push("External Capability Gateway 构造固定业务 Subject");
  }

  const runtimeClient = stripComments(source("lib/runtime/runtime-client.ts"));
  const requestStart = runtimeClient.indexOf("export interface StartInvocationRequestBody");
  const requestEnd = runtimeClient.indexOf(
    "export interface StartInvocationResponse",
    requestStart,
  );
  const requestBody =
    requestStart >= 0 && requestEnd > requestStart
      ? runtimeClient.slice(requestStart, requestEnd)
      : "";
  if (/\b(?:subjectId|subject_id|executionSubject|execution_subject)\s*[?:]/.test(requestBody)) {
    failures.push("Runtime Start 请求体重新成为 Subject Authority");
  }

  const agentCallSchema = stripComments(source("lib/persistence/schema/agent-calls.ts"));
  const callStart = agentCallSchema.indexOf("export const agentCallTable");
  const callEnd = agentCallSchema.indexOf("export const agentCallBindingTable", callStart);
  const callBlock =
    callStart >= 0 && callEnd > callStart ? agentCallSchema.slice(callStart, callEnd) : "";
  if (/\b(?:agentRevisionId|externalContextRef|externalTaskRef)\s*:/.test(callBlock)) {
    failures.push("AgentCall 主表重新加入 revision/context/task Authority");
  }

  for (const producerPath of [
    "lib/agents/calls/persistence/apply-agent-call-transition.ts",
    "lib/conversations/user-action-resolve-queries.ts",
  ]) {
    const producer = stripComments(source(producerPath));
    if (
      !producer.includes("controlPlaneOutboxEvent") ||
      !producer.includes("controlPlaneEventDelivery")
    ) {
      failures.push(`Continuation 生产端未写 durable Outbox：${producerPath}`);
    }
  }

  const hosted = stripComments(source("lib/runtime/adapters/hosted-adapter.ts"));
  const resumeStart = hosted.indexOf("async handleResume(");
  const resumeEnd = hosted.indexOf("async handleSteer(", resumeStart);
  const resumeBlock =
    resumeStart >= 0 && resumeEnd > resumeStart ? hosted.slice(resumeStart, resumeEnd) : "";
  if (
    !resumeBlock.includes("new HostedHarnessLoop(") ||
    !resumeBlock.includes("await runPromise")
  ) {
    failures.push("Hosted Resume 退化为只 ACK");
  }

  const seen = new Map<string, string>();
  for (const test of testCollection) {
    const previous = seen.get(test.file);
    if (previous) failures.push(`测试重复分组：${test.file} (${previous}, ${test.group})`);
    else seen.set(test.file, test.group);
  }

  return { passed: failures.length === 0, failures: [...new Set(failures)] };
}
