/**
 * 生产接线的纯规则实现（唯一一套口径）。
 *
 * 业务不变量：默认生产入口与 Authority 映射必须由真实生产源码事实支撑——
 * 「文件存在」或「名称出现过」都不算接线。本模块接收 SourceDocument 集合，返回违规
 * 描述数组（空数组 = 通过），由两个消费者共用，避免出现两套互相漂移的检查：
 * - `scripts/production-wiring.ts`：验收计划 `production-wiring` 阶段的独立入口；
 * - `scripts/production-wiring.contract.test.ts`：contract 组用例。
 *
 * fail-closed：每条规则先读目标文件，**读不到即记违规**。否则「不允许出现 X」一类
 * 断言会在空串上假通过——目标文件被改名或删除时，门禁反而变绿。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export interface SourceDocument {
  path: string;
  source: string;
}

export interface ProductionWiringCheck {
  /** 稳定编号，供用例与阶段输出引用。 */
  id: string;
  /** 人类可读说明，与 contract 组用例标题逐字一致。 */
  title: string;
  /** 返回违规描述；空数组 = 该条接线规则成立。 */
  run: (documents: readonly SourceDocument[]) => string[];
}

export interface ProductionWiringResult {
  id: string;
  title: string;
  violations: string[];
}

// ─── 文档加载：两个消费者读的必须是同一批真实文件 ─────────────────────────

const PRODUCTION_ROOTS = ["app", "components", "desktop", "hooks", "lib", "scripts"];
/** 生产拓扑不在上述源码根下，必须显式纳入，否则相关规则会读空串。 */
const EXTRA_DOCUMENTS = ["package.json", "deploy/production/compose.yaml"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".json", ".md", ".py"]);

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => {
    if ([".git", ".next", "build", "dist", "node_modules", "__pycache__"].includes(entry)) {
      return [];
    }
    return filesUnder(resolve(path, entry));
  });
}

/** 读取真实生产文档集合（与 `scripts/architecture-gate.ts` 同作用域口径）。 */
export function loadProductionWiringDocuments(root = process.cwd()): SourceDocument[] {
  const fromRoots = PRODUCTION_ROOTS.flatMap((name) => filesUnder(resolve(root, name))).filter(
    (file) => SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))),
  );
  const extras = EXTRA_DOCUMENTS.map((name) => resolve(root, name)).filter((file) =>
    existsSync(file),
  );
  return [...fromRoots, ...extras].map((file) => ({
    path: relative(root, file),
    source: readFileSync(file, "utf8"),
  }));
}

// ─── 规则构造 ──────────────────────────────────────────────────────────────

interface Inspector {
  /** 读取目标文件；读不到即记一条「目标文件缺失」违规并返回空串。 */
  read: (path: string) => string;
  /** 目标文件必须包含该字面量。 */
  requires: (path: string, needle: string) => void;
  /** 目标文件不得命中该模式。 */
  forbids: (path: string, pattern: RegExp, label: string) => void;
  /** 手工登记一条违规（用于跨文件或顺序类判断）。 */
  violate: (message: string) => void;
}

function rule(run: (wire: Inspector) => void): ProductionWiringCheck["run"] {
  return (documents) => {
    const sources = new Map(documents.map((document) => [document.path, document.source]));
    const violations: string[] = [];
    const reportedMissing = new Set<string>();

    const read = (path: string): string => {
      const source = sources.get(path);
      if (source !== undefined) return source;
      if (!reportedMissing.has(path)) {
        reportedMissing.add(path);
        violations.push(`接线目标文件缺失：${path}`);
      }
      return "";
    };

    run({
      read,
      requires: (path, needle) => {
        if (!read(path).includes(needle)) violations.push(`${path} 缺少：${needle}`);
      },
      forbids: (path, pattern, label) => {
        if (pattern.test(read(path))) violations.push(`${path} 不允许出现：${label}`);
      },
      violate: (message) => violations.push(message),
    });
    return violations;
  };
}

function check(id: string, title: string, run: (wire: Inspector) => void): ProductionWiringCheck {
  return { id, title, run: rule(run) };
}

// ─── 十条接线规则 ──────────────────────────────────────────────────────────

const PLATFORM_EXECUTORS = "lib/runtime/harness-loop/platform-action-executors.ts";
const HOSTED_ADAPTER = "lib/runtime/adapters/hosted-adapter.ts";
const RUNTIME_RESUME = "lib/runtime/application/runtime-resume.ts";
const CAPABILITY_GATEWAY = "app/gateway/capability-actions/route.ts";
const WORKER_ROLE_FACTORY = "lib/workers/production-worker-role.ts";
const CONTINUATION_WORKER = "lib/runtime/continuation/production-invocation-continuation-worker.ts";
const RETRY_WORKER = "lib/runtime/retry/runtime-dispatch-retry-worker.ts";

const PW_01 = check(
  "PW-01",
  "shared production executor registers tool.call through the ToolCall application service",
  (wire) => {
    const executor = "lib/runtime/harness-loop/tool-action-executor.ts";
    const hostedApplication = "lib/capability/application/execute-harness-tool-call.ts";
    const toolGateway = "app/gateway/tool-calls/route.ts";

    wire.requires(PLATFORM_EXECUTORS, '"tool.call": createToolActionExecutor');
    wire.requires(executor, 'from "@/lib/capability/application/execute-harness-tool-call"');
    // Harness Tool 执行器不得自己直连 Provider；网络调用只属于 durable Tool worker。
    wire.forbids(executor, /fetch\(|providerEndpoint|endpointRef/, "直连 Provider 或 endpoint");
    wire.requires(hostedApplication, "applyToolCall");
    wire.requires(toolGateway, "applyToolCall");
    wire.forbids(toolGateway, /createToolCall/, "绕过 canonical ToolCall application service");
  },
);

const PW_02 = check(
  "PW-02",
  "Tool worker 真实拥有 Provider、Effect 与 durable continuation",
  (wire) => {
    const worker = "lib/capability/tool-execution-worker.ts";
    wire.requires(worker, "claimNextQueuedToolCall");
    wire.requires(worker, "reconcileEffect");
    wire.requires(worker, 'eventType: "tool_call.continuation.requested"');
    wire.requires("lib/capability/provider-executor.ts", 'method: "POST"');
    wire.requires(
      "scripts/workers/tool-execution-worker.ts",
      'runProductionWorkerProcess("tool-execution-worker")',
    );
    wire.requires(WORKER_ROLE_FACTORY, "createToolExecutionWorker");
  },
);

const PW_03 = check(
  "PW-03",
  "Hosted and External paths use the same catalog-aware production factory",
  (wire) => {
    // 唯一 catalog-aware 生产 factory（Hosted 进程内与 Gateway HTTP 共用）。
    wire.requires(PLATFORM_EXECUTORS, "createPlatformHarnessActionExecutors");
    wire.requires(PLATFORM_EXECUTORS, "capabilityCatalog");
    wire.requires(CAPABILITY_GATEWAY, "createPlatformHarnessActionExecutors");
    wire.requires(CAPABILITY_GATEWAY, "capabilityCatalog");
    wire.requires(RUNTIME_RESUME, "new HostedHarnessLoop");
    wire.requires(HOSTED_ADAPTER, "executors: this.params.actionExecutors ?? {}");
    wire.requires(HOSTED_ADAPTER, "capabilityCatalog: this.params.capabilityCatalog");
  },
);

const PW_04 = check(
  "PW-04",
  "Harness validates every action against the frozen catalog before executor dispatch",
  (wire) => {
    const loop = "lib/runtime/harness-loop/loop.ts";
    const text = wire.read(loop);
    const validation = text.indexOf("validateHarnessActionAgainstCatalog");
    const dispatch = text.indexOf("this.executeAction(historyEntry");
    if (validation < 0) wire.violate(`${loop} 缺少：validateHarnessActionAgainstCatalog`);
    if (dispatch < 0) wire.violate(`${loop} 缺少：this.executeAction(historyEntry`);
    // 两处都存在才比较顺序；只比较 -1 会让缺失被误判为「顺序正确」。
    if (validation >= 0 && dispatch >= 0 && validation >= dispatch) {
      wire.violate(`${loop} 的 Catalog 校验不在 executor dispatch 之前`);
    }
  },
);

const PW_05 = check(
  "PW-05",
  "identity wiring freezes once and recovers the trusted subject through ExecutionBinding without gateway fallback",
  (wire) => {
    const retry = "lib/runtime/retry/dispatch-queued-invocation-attempt.ts";
    const agentResume = "app/gateway/agent-calls/[callId]/resume/route.ts";
    wire.requires("lib/runtime/dispatcher.ts", "freezeTrustedExecutionSubject");
    // Retry lane 从 durable ExecutionBinding 恢复执行事实，不向 gateway 索要身份。
    wire.requires(retry, "getExecutionBindingByInvocation");
    wire.requires(retry, "startRuntimeInvocation({");
    wire.requires(CONTINUATION_WORKER, "recoverTrustedExecutionSubject(binding");
    wire.requires(CAPABILITY_GATEWAY, "recoverTrustedExecutionSubject(binding");
    wire.requires(agentResume, "recoverTrustedExecutionSubject(binding");
    wire.forbids(
      "lib/runtime/application/build-runtime-start-request.ts",
      /executionSubject/,
      "Start 请求体重新携带 Subject Authority",
    );
    const fixedGatewaySubject =
      'executionSubjectFromServiceIdentity(principal.tenantId, "gateway")';
    if (
      `${wire.read(CAPABILITY_GATEWAY)}\n${wire.read(agentResume)}`.includes(fixedGatewaySubject)
    ) {
      wire.violate("External Gateway / AgentCall resume 回退到固定 gateway Subject");
    }
  },
);

const PW_06 = check("PW-06", "AgentCall ingress、取消与用户恢复共用唯一状态转换入口", (wire) => {
  const transition = "lib/agents/calls/persistence/apply-agent-call-transition.ts";
  wire.requires("lib/agents/calls/application/ingest-agent-call-events.ts", "applyAgentCallEvent");
  wire.requires(transition, "controlPlaneOutboxEvent");
  wire.requires(transition, "beforeVersionNo");
  wire.requires(transition, "afterVersionNo");
  wire.requires("lib/agents/calls/application/cancel-agent-call.ts", "transitionAgentCall");
  wire.requires("lib/agents/calls/application/resume-agent-call.ts", "transitionAgentCall");
});

const PW_07 = check(
  "PW-07",
  "Continuation worker 进入正式启动入口并调用唯一 Harness resume 能力",
  (wire) => {
    wire.requires(
      "scripts/workers/control-plane-outbox-worker.ts",
      'runProductionWorkerProcess("control-plane-outbox-worker")',
    );
    wire.requires(WORKER_ROLE_FACTORY, "createProductionInvocationContinuationWorker");
    wire.requires(WORKER_ROLE_FACTORY, "continuationWorker.pollOnce()");
    // continuation 事件不携带 authority tuple，因此 worker 必须经
    // `resumeHarnessContinuation`（从当前 active Owner + 唯一 Session 重建 authority），
    // 不能直接调 `resumeHarnessInvocation` 而让 authority 缺省。
    wire.requires(CONTINUATION_WORKER, "resumeHarnessContinuation");
    wire.requires(CONTINUATION_WORKER, "recoverTrustedExecutionSubject");
    // 唯一生产 Resume 能力：runtime-resume.ts 进程内驱动 HostedHarnessLoop。
    wire.requires(RUNTIME_RESUME, "async function resumeHarnessInvocation");
    wire.requires(RUNTIME_RESUME, "export async function resumeHarnessContinuation");
    wire.requires(RUNTIME_RESUME, "new HostedHarnessLoop");
    wire.requires(HOSTED_ADAPTER, "new HostedHarnessLoop");
    wire.forbids(HOSTED_ADAPTER, /Resume 不需要额外事件/, "Resume 真值被文档化放弃");
  },
);

const PW_08 = check(
  "PW-08",
  "External Runtime 默认生产入口创建绑定 HTTP transport 且不回退 Hosted",
  (wire) => {
    const dispatcher = "lib/runtime/employee-turn-dispatcher.ts";
    const transport = "lib/runtime/transport/http-harness-runtime-transport.ts";
    wire.requires(dispatcher, "createHttpHarnessRuntimeTransport({ endpoint, auth })");
    for (const method of [
      "probeCapabilities",
      "startInvocation",
      "cancelInvocation",
      "resumeInvocation",
      "steerInvocation",
    ]) {
      wire.requires(transport, `client.${method}`);
    }
    wire.forbids(dispatcher, /external_endpoint_fallback_hosted/, "External 端点缺失时回退 Hosted");
  },
);

const PW_09 = check(
  "PW-09",
  "Runtime retry 默认 lane 调用持久化 Attempt 服务而不是伪造失败",
  (wire) => {
    const service = "lib/runtime/retry/dispatch-persisted-queued-invocation-attempt.ts";
    wire.requires(
      RETRY_WORKER,
      "deps.dispatchPersistedAttempt ?? dispatchPersistedQueuedInvocationAttempt",
    );
    // 领取身份是 Session（claim），不是裸 Attempt ID。
    wire.requires(RETRY_WORKER, "await persistedAttemptDispatcher(claim)");
    wire.requires(RETRY_WORKER, "scanDueSessionDispatches");
    wire.requires(RETRY_WORKER, "claimSessionDispatch");
    wire.forbids(RETRY_WORKER, /runtime_unavailable/, "以伪造失败替代真实持久化派发");
    wire.requires(service, "createHttpHarnessRuntimeTransport");
    wire.requires(service, "dispatchQueuedInvocationAttempt");
  },
);

const PW_10 = check(
  "PW-10",
  "四类 durable Worker 都由统一生产 role factory 与镜像入口启动",
  (wire) => {
    for (const role of [
      "hosted-provisioning-worker",
      "control-plane-outbox-worker",
      "runtime-dispatch-retry-worker",
      "tool-execution-worker",
    ]) {
      wire.requires(WORKER_ROLE_FACTORY, `"${role}"`);
      wire.requires("deploy/production/compose.yaml", `WORKER_ROLE: ${role}`);
    }
    wire.requires("scripts/workers/worker-entrypoint.ts", "runProductionWorkerProcess");
  },
);

/** 十条规则的固定顺序（编号即口径，不得增删或换序）。 */
export const PRODUCTION_WIRING_CHECKS: readonly ProductionWiringCheck[] = [
  PW_01,
  PW_02,
  PW_03,
  PW_04,
  PW_05,
  PW_06,
  PW_07,
  PW_08,
  PW_09,
  PW_10,
];

/** 逐条执行全部接线规则，保留编号与标题。 */
export function collectProductionWiringViolations(
  documents: readonly SourceDocument[],
): ProductionWiringResult[] {
  return PRODUCTION_WIRING_CHECKS.map((entry) => ({
    id: entry.id,
    title: entry.title,
    violations: entry.run(documents),
  }));
}
