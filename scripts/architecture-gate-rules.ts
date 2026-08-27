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

// ─── Runtime Registration 证据 Gate（08 §4）─────────────────

const REGISTRATION_EVIDENCE_PATH = "lib/runtime/application/register-agent-runtime.ts";

/** Registration 必须引用的正式 Conformance 证据链标识。 */
const REGISTRATION_REQUIRED_IDENTIFIERS = [
  "buildActiveExternalConformanceReport",
  "prepareRuntimeConformanceRun",
  "appendRuntimeConformanceRun",
  "createMysqlRuntimeConformanceRunSession",
] as const;

/** Registration 禁止 import 的测试/伪造证据来源。 */
const REGISTRATION_FORBIDDEN_IMPORTS = [
  "@/lib/runtime/test-support/build-dsse-conformance-envelope",
  "@/lib/artifacts/test-support/",
  "ed25519-signer-keypair",
] as const;

export interface RegistrationEvidenceGateResult {
  passed: boolean;
  failures: string[];
}

export function checkRuntimeRegistrationEvidence(
  documents: readonly SourceDocument[],
): RegistrationEvidenceGateResult {
  const document = documents.find((item) => item.path === REGISTRATION_EVIDENCE_PATH);
  if (!document) {
    return { passed: false, failures: [`${REGISTRATION_EVIDENCE_PATH} 不存在`] };
  }
  const failures: string[] = [];
  for (const identifier of REGISTRATION_REQUIRED_IDENTIFIERS) {
    if (!document.source.includes(identifier)) {
      failures.push(`缺少正式证据链引用：${identifier}`);
    }
  }
  for (const forbidden of REGISTRATION_FORBIDDEN_IMPORTS) {
    if (document.source.includes(forbidden)) {
      failures.push(`禁止 import 测试/伪造证据来源：${forbidden}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

// ─── Resume Gate（08 §5）────────────────────────────────────

const RESOLVE_ROUTE_PATH =
  "app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route.ts";
const A2A_TRANSPORT_PATH = "lib/runtime/transport/a2a-transport.ts";

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
    // A2A resumeInvocation 必须使用公共 metadata mapper（04 §12）。
    const resumeIndex = transport.source.indexOf("async resumeInvocation");
    const resumeSlice =
      resumeIndex >= 0 ? transport.source.slice(resumeIndex, resumeIndex + 3000) : "";
    if (!resumeSlice.includes("buildA2APublicMessageMetadata")) {
      failures.push("a2a-transport.resumeInvocation 未使用公共 metadata mapper");
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
 * - F3 Hard-coded Conformance Context：register-agent-runtime 的 Probe metadata
 *   必须来自正式 Conformance Context Builder，禁止手写 execution_subject/
 *   current_datetime/locale。
 * - F4 Cancel Probe context：probeCancel 必须接收并使用 metadata factory。
 * - F5 Resume dispatched=false：resolve route 必须显式 switch 三种 reason，
 *   禁止 if(!dispatched) local 200 一把梭。
 * - F6 Capability hardcode：A2A Start response 不得硬编码 cancel/resume/user_action=true，
 *   必须投影 params.capabilities。
 * - F7 Contract invalid combo：Parser 必须包含 input_required=true → resume=true。
 * - F8 Durable semantics：Builder 不得因 declared durable=true + not_measured +
 *   effective=false 判 Conformance fail。
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

  // F3 Hard-coded Conformance Context
  const registration = docOrFail(
    documents,
    "lib/runtime/application/register-agent-runtime.ts",
    failures,
  );
  if (registration) {
    if (!registration.source.includes("buildExternalConformanceProbeContext")) {
      failures.push("F3 register-agent-runtime 未使用正式 Conformance Context Builder");
    }
    // 剥离注释后禁止手写公共 context kind 构造（正则自身含这些词，规则文件已排除）。
    const source = stripComments(registration.source);
    if (/context_kind:\s*["'](execution_subject|current_datetime|locale)["']/.test(source)) {
      failures.push("F3 register-agent-runtime 手写 Probe context kind（硬编码 metadata）");
    }
  }

  // F4 Cancel Probe context
  if (registration) {
    const cancelIndex = registration.source.indexOf("async function probeCancel");
    const cancelSlice =
      cancelIndex >= 0 ? registration.source.slice(cancelIndex, cancelIndex + 1200) : "";
    if (!cancelSlice || !/metadata/.test(cancelSlice)) {
      failures.push("F4 probeCancel 缺少 metadata factory 参数（Cancel start message Context）");
    }
    const cancelCallIndex = registration.source.indexOf("await probeCancel(");
    const cancelCallSlice =
      cancelCallIndex >= 0 ? registration.source.slice(cancelCallIndex, cancelCallIndex + 400) : "";
    if (!cancelCallSlice || !/probeMetadata/.test(cancelCallSlice)) {
      failures.push("F4 probeCancel 调用未传入 probeMetadata");
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
  const transport = docOrFail(documents, "lib/runtime/transport/a2a-transport.ts", failures);
  if (transport) {
    const source = stripComments(transport.source);
    if (
      /cancel:\s*true\b/.test(source) ||
      /resume:\s*true\b/.test(source) ||
      /user_action:\s*true\b/.test(source)
    ) {
      failures.push("F6 A2A Transport 硬编码 cancel/resume/user_action=true");
    }
    const startIdx = source.indexOf("runtime_session_ref: contextId");
    const startSlice = startIdx >= 0 ? source.slice(startIdx, startIdx + 1200) : "";
    if (!startSlice || !startSlice.includes("params.capabilities.cancel")) {
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

  // F8 Durable semantics
  const builder = docOrFail(
    documents,
    "lib/runtime/application/build-active-external-conformance.ts",
    failures,
  );
  if (builder) {
    const source = stripComments(builder.source);
    if (/!declaredDurable\s*&&/.test(source)) {
      failures.push("F8 Builder 仍因 declared durable 未测而判 Conformance fail");
    }
    if (!source.includes('measuredDurable === "not_measured"')) {
      failures.push("F8 Builder durable case 未按 not_measured 三态诚实裁决");
    }
  }

  return { passed: failures.length === 0, failures };
}
