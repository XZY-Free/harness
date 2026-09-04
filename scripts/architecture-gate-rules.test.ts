import { describe, expect, it } from "vitest";
import {
  type SourceDocument,
  checkAgentCallFinalizationGate,
  checkAgentCallRuntimeBoundaryGate,
  checkAgentExecutionAuthorityGate,
  checkAgentInvokeAuthorizationGate,
  checkAgentRevisionAuthorityGate,
  checkDispatchRecoveryAuthorityGate,
  checkResumeTruthfulnessGate,
  collectDeprecatedArchitectureViolations,
  collectExecutionBoundaryViolations,
  collectHarnessAgentBoundaryViolations,
  collectImplementationHistoryViolations,
  collectRetiredAgentExecutionViolations,
  collectRetiredModuleDependencyViolations,
} from "./architecture-gate-rules";

/**
 * Architecture Gate 的 retired implementation 检查边界（纯规则模块）。
 *
 * 业务不变量：/test-support/ 不因路径整体豁免——只允许 .test.ts/.test.tsx 与
 * 显式精确文件白名单跳过。该模块是抽取自 architecture-gate.ts 的纯规则实现
 * （不得内含 fallback / 内联复制生产算法），以 SourceDocument 数组为输入、
 * 返回违规路径数组，便于单测证明 test-support 被扫描。
 *
 * 规则 API：
 *   type SourceDocument = { path: string; source: string }
 *   collectDeprecatedArchitectureViolations(documents, allowlist?) => string[]
 */

function doc(path: string, source: string): SourceDocument {
  return { path, source };
}

describe("source history and retired dependency gates", () => {
  it("Agent/Runtime/Route 正式源码出现施工编号时失败", () => {
    const documents = [
      doc("lib/agents/application/example.ts", "// Batch 8"),
      doc("lib/runtime/example.ts", "// docs/V12/01/03 §5"),
      doc("lib/routes/example.ts", "// 阶段 6 S06-C04"),
    ];
    expect(collectImplementationHistoryViolations(documents)).toEqual([
      "lib/agents/application/example.ts",
      "lib/runtime/example.ts",
      "lib/routes/example.ts",
    ]);
  });

  it("docs 历史、测试拒绝文本与合法协议版本不误报", () => {
    const documents = [
      doc("docs/V12/01/history.md", "Batch 8 Stage C"),
      doc("lib/runtime/example.test.ts", "expect(source).not.toContain('专题01')"),
      doc("lib/agents/transport.ts", 'const protocolVersion = "0.3.0"; const api = "/v1";'),
    ];
    expect(collectImplementationHistoryViolations(documents)).toEqual([]);
  });

  it("test-support 不按目录豁免施工历史", () => {
    const documents = [doc("lib/agents/test-support/provider.ts", "// Phase 2 temporary provider")];
    expect(collectImplementationHistoryViolations(documents)).toEqual([
      "lib/agents/test-support/provider.ts",
    ]);
  });

  it("外部规范只可按精确文件豁免", () => {
    const documents = [
      doc("lib/artifacts/verification/schemas/external.json", "Phase 2"),
      doc("lib/runtime/internal.ts", "Phase 2"),
    ];
    expect(
      collectImplementationHistoryViolations(
        documents,
        new Set(["lib/artifacts/verification/schemas/external.json"]),
      ),
    ).toEqual(["lib/runtime/internal.ts"]);
  });

  it("生产或测试 import 已删除模块时失败，纯拒绝文本合法", () => {
    const documents = [
      doc(
        "lib/routes/example.test.ts",
        'import { upsert } from "@/lib/routes/application/upsert-deployment-route";',
      ),
      doc(
        "lib/agents/test-support/provider.ts",
        'export { old } from "@/lib/runtime/transport/a2a-transport";',
      ),
      doc(
        "lib/routes/rejection.test.ts",
        'expect(source).not.toContain("@/lib/routes/application/disable-deployment-route")',
      ),
    ];
    expect(collectRetiredModuleDependencyViolations(documents)).toEqual([
      "lib/routes/example.test.ts",
      "lib/agents/test-support/provider.ts",
    ]);
  });

  it("旧 Required-Agent 执行桥、符号与幂等前缀重新出现时失败", () => {
    const documents = [
      doc("lib/runtime/old-bridge.ts", "invokeRequiredAgent();"),
      doc("lib/agents/calls/old.ts", 'const prefix = "required-agent";'),
      doc("scripts/architecture-gate-rules.test.ts", "invokeRequiredAgent();"),
    ];
    expect(collectRetiredAgentExecutionViolations(documents)).toEqual([
      "lib/runtime/old-bridge.ts",
      "lib/agents/calls/old.ts",
    ]);
  });
});

describe("checkAgentCallRuntimeBoundaryGate", () => {
  const valid = (): SourceDocument[] => [
    doc(
      "lib/agents/calls/application/agent-action-executor.ts",
      "const current = await startAgentCall(command); return toAgentCallDisposition(current);",
    ),
    doc(
      "lib/agents/calls/application/start-agent-call.ts",
      "const transport = createA2AAgentTransport(options); return store.getById(query);",
    ),
    doc(
      "lib/runtime/adapters/hosted-adapter.ts",
      "const preferredCandidate = params.capabilityDirectives;",
    ),
  ];

  it("一次 start + durable disposition + pending handoff 时通过", () => {
    expect(checkAgentCallRuntimeBoundaryGate(valid())).toEqual({ passed: true, failures: [] });
  });

  it("Harness bridge 出现同步轮询、等待常量或 timeout 参数时失败", () => {
    const documents = valid();
    documents[0] = doc(
      "lib/agents/calls/application/agent-action-executor.ts",
      "const MAX_WAIT_MS = 30_000; while (true) { await setTimeout(POLL_INTERVAL_MS); } const pollTimeoutMs = 1;",
    );
    expect(checkAgentCallRuntimeBoundaryGate(documents).failures).toContain(
      "Harness AgentCall bridge 仍包含同步轮询或 timeout 生命周期",
    );
  });

  it("Runtime 生产代码直接建立 A2A AgentTransport 时失败", () => {
    const documents = [
      ...valid(),
      doc(
        "lib/runtime/hosted-agent.ts",
        'import { createA2AAgentTransport } from "@/lib/agents/calls/transport/a2a/a2a-client";',
      ),
    ];
    expect(checkAgentCallRuntimeBoundaryGate(documents).failures).toContain(
      "Runtime 越权建立 Agent A2A outbound：lib/runtime/hosted-agent.ts",
    );
  });

  it("Hosted adapter 从 preferred directive 自动调用 Agent 时失败", () => {
    const documents = valid();
    documents[2] = doc(
      "lib/runtime/adapters/hosted-adapter.ts",
      "const selected = capabilityDirectives?.find(Boolean); await agentCallExecutor(selected);",
    );
    expect(checkAgentCallRuntimeBoundaryGate(documents).failures).toContain(
      "Hosted Harness 把 preferred directive 当成 AgentCall 执行要求",
    );
  });
});

describe("checkAgentRevisionAuthorityGate", () => {
  const valid = (): SourceDocument[] => [
    doc(
      "lib/persistence/schema/agents.ts",
      "currentRevisionId; 反规范化摘要; Publication Route Projection Binding;",
    ),
    doc(
      "lib/agents/persistence/agent-revision-queries.ts",
      "agentContractSnapshotTable; params.tenantId; snapshot.agentId !== params.agentId;",
    ),
    doc(
      "lib/agents/application/publish-agent-revision.ts",
      "snapshot.recomputedContractDigest; snapshot.recomputedCapabilityDigest; snapshot.recomputedContextDigest;",
    ),
    doc(
      "lib/agents/calls/application/start-agent-call.ts",
      "binding.agentRevisionId; binding.agentContractSnapshotId;",
    ),
  ];

  it("currentRevision 摘要、Snapshot 精确绑定与发布重算齐备时通过", () => {
    expect(checkAgentRevisionAuthorityGate(valid())).toEqual({ passed: true, failures: [] });
  });

  it("AgentCall 执行读取 Agent.currentRevisionId 或 latest helper 时失败", () => {
    const documents = [
      ...valid(),
      doc(
        "lib/agents/calls/application/resolve.ts",
        "const revision = agentTable.currentRevisionId ?? getLatestPublishedRevision(agent.id);",
      ),
    ];
    const failures = checkAgentRevisionAuthorityGate(documents).failures.join("\n");
    expect(failures).toContain("currentRevisionId");
    expect(failures).toContain("latest/current revision fallback");
  });

  it("第二套 Contract 版本或发布 Authority 命名失败", () => {
    const documents = [
      ...valid(),
      doc(
        "lib/agents/application/contract-publication.ts",
        "class AgentContractRevision {} class ContractPublication {}",
      ),
    ];
    expect(checkAgentRevisionAuthorityGate(documents).failures).toContain(
      "Agent Contract 第二版本轴/发布 Authority 仍存在：lib/agents/application/contract-publication.ts",
    );
  });
});

describe("checkAgentCallFinalizationGate", () => {
  const valid = (): SourceDocument[] => [
    doc("lib/agents/calls/application/create-agent-call.ts", "store.finalizeAgentCall(candidate);"),
    doc(
      "lib/agents/calls/persistence/mysql-agent-call-store.ts",
      "finalizeAgentCall; lockAndValidateAgentCallAuthority; recordCapabilityUse(tx);",
    ),
    doc(
      "lib/agents/calls/application/resolve-agent-call-binding.ts",
      "bindingCandidate; buildAgentCallBindingCandidate();",
    ),
    doc(
      "lib/persistence/schema/agent-calls.ts",
      "creationRequestDigest; projectionVersionNo; export const agentCallTable = {}; export type AgentCall = {}; export const agentCallAttemptTable = { externalTaskRef: true }; export type AgentCallAttempt = {};",
    ),
    doc(
      "lib/agents/calls/domain/agent-call-attempt.ts",
      "export interface AgentCallAttempt { externalTaskRef: string | null }",
    ),
  ];

  it("finalize 事务、creation digest 与 candidate 语义齐备时通过", () => {
    expect(checkAgentCallFinalizationGate(valid()).passed).toBe(true);
  });

  it("create application 在提交后补记 CapabilityUse 时失败", () => {
    const docs = valid().map((item) =>
      item.path === "lib/agents/calls/application/create-agent-call.ts"
        ? doc(item.path, "store.finalizeAgentCall(candidate); recordCapabilityUse(input);")
        : item,
    );
    expect(checkAgentCallFinalizationGate(docs).failures).toContain(
      "AgentCall creation 仍在事务外写 CapabilityUse",
    );
  });

  it("旧 createIdempotent 或假事实 fallback 仍存在时失败", () => {
    const docs = [
      ...valid(),
      doc(
        "lib/agents/calls/persistence/old-store.ts",
        'createIdempotent(); const version = projectionVersionNo ?? 0; const endpoint = endpointRef ?? "";',
      ),
    ];
    const failures = checkAgentCallFinalizationGate(docs).failures.join("\n");
    expect(failures).toContain("createIdempotent");
    expect(failures).toContain("假事实 fallback");
  });

  it("AgentCall 主表重新复制 externalTaskRef Authority 时失败", () => {
    const docs = valid().map((item) =>
      item.path === "lib/persistence/schema/agent-calls.ts"
        ? doc(
            item.path,
            "creationRequestDigest; projectionVersionNo; export const agentCallTable = { externalTaskRef: true }; export type AgentCall = {}; export const agentCallAttemptTable = { externalTaskRef: true }; export type AgentCallAttempt = {};",
          )
        : item,
    );
    expect(checkAgentCallFinalizationGate(docs).failures).toContain(
      "AgentCall externalTaskRef 未唯一归属 AgentCallAttempt",
    );
  });
});

describe("checkAgentInvokeAuthorizationGate", () => {
  const validDocuments = (): SourceDocument[] => [
    doc(
      "lib/identity/action-codes.ts",
      'const ACTION_CODES = ["agent.invoke"]; const TYPES = { "agent.invoke": ["tenant", "agent"] };',
    ),
    doc("lib/persistence/schema/agents.ts", "export const agentTable = {}"),
    doc("lib/agents/persistence/agent-queries.ts", "export function createAgent() {}"),
    doc("lib/agents/application/agent-admin-projection.ts", "export function projectAgent() {}"),
    doc("lib/control-plane-client/contracts/agent.ts", "export interface AgentDTO {}"),
    doc(
      "app/api/v1/threads/[thread_id]/turns/route.ts",
      "requireAgentInvokeScope(); enforceIdempotency();",
    ),
    doc(
      "app/api/v1/catalog/options/route.ts",
      "resolveActionScopeCoverage(); agentInvokeAuthorization; buildEmployeeCatalogEtag();",
    ),
    doc("components/hooks/use-catalog.ts", 'fetch("/api/v1/catalog/options?resource_type=agent")'),
  ];

  it("正式 agent.invoke/Catalog/Turn 单一路径通过", () => {
    expect(checkAgentInvokeAuthorizationGate(validDocuments())).toEqual({
      passed: true,
      failures: [],
    });
  });

  it("旧员工 Agent endpoint 与 visibility Authority 被拦截", () => {
    const documents = validDocuments();
    documents.push(doc("app/api/v1/agents/route.ts", "export function GET() {}"));
    documents.push(doc("components/selector.tsx", 'fetch("/api/v1/agents")'));
    documents[1] = doc("lib/persistence/schema/agents.ts", "const visibilityPolicyId = null");
    const result = checkAgentInvokeAuthorizationGate(documents);
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toContain("双轨入口");
    expect(result.failures.join("\n")).toContain("旧 Authority");
    expect(result.failures.join("\n")).toContain("客户端仍消费");
  });

  it("Turn 授权晚于幂等写入时失败", () => {
    const documents = validDocuments();
    documents[5] = doc(
      "app/api/v1/threads/[thread_id]/turns/route.ts",
      "enforceIdempotency(); requireAgentInvokeScope();",
    );
    expect(checkAgentInvokeAuthorizationGate(documents).failures).toContain(
      "Turn agent selection 未在幂等/写入前经过 requireAgentInvokeScope",
    );
  });
});

describe("collectDeprecatedArchitectureViolations", () => {
  it("lib/runtime/test-support/fixture.ts 含 @deprecated 时返回违规（test-support 不被整体豁免）", () => {
    const documents = [
      doc("lib/runtime/test-support/fixture.ts", "export const x = 1; // @deprecated 旧实现"),
    ];
    expect(collectDeprecatedArchitectureViolations(documents)).toContain(
      "lib/runtime/test-support/fixture.ts",
    );
  });

  it("lib/runtime/test-support/ 含 legacy 禁词时返回违规", () => {
    const documents = [
      doc("lib/runtime/test-support/seed-verified-runtime-attestation.ts", "const legacy = true;"),
    ];
    expect(collectDeprecatedArchitectureViolations(documents)).toContain(
      "lib/runtime/test-support/seed-verified-runtime-attestation.ts",
    );
  });

  it("lib/runtime/example.test.ts 与 example.test.tsx 可跳过", () => {
    const documents = [
      doc("lib/runtime/example.test.ts", "// @deprecated legacy"),
      doc("lib/runtime/example.test.tsx", "const legacy = true;"),
    ];
    expect(collectDeprecatedArchitectureViolations(documents)).toEqual([]);
  });

  it("精确 allowlist 中的单个文件可跳过，但同目录其他文件不能被连带豁免", () => {
    const allowlist = new Set(["lib/runtime/test-support/fixture.ts"]);
    const documents = [
      doc("lib/runtime/test-support/fixture.ts", "// @deprecated 官方旧夹具"),
      doc("lib/runtime/test-support/sibling.ts", "const legacy = true;"),
    ];
    const violations = collectDeprecatedArchitectureViolations(documents, allowlist);
    expect(violations).not.toContain("lib/runtime/test-support/fixture.ts");
    expect(violations).toContain("lib/runtime/test-support/sibling.ts");
  });

  it("非目标作用域（lib/skill/）不纳入此专题 deprecated 检查", () => {
    const documents = [doc("lib/skill/invocations.ts", "// @deprecated legacy 仅在 lib/skill 下")];
    expect(collectDeprecatedArchitectureViolations(documents)).toEqual([]);
  });

  it("正常的 lib/runtime/test-support helper 不含禁词时无违规", () => {
    const documents = [
      doc(
        "lib/runtime/test-support/build-dsse-conformance-envelope.ts",
        "export function build(): string { return 'clean'; }",
      ),
    ];
    expect(collectDeprecatedArchitectureViolations(documents)).toEqual([]);
  });

  it("精确 allowlist 不接受目录前缀（必须逐文件精确）", () => {
    const allowlist = new Set(["lib/runtime/test-support/"]);
    const documents = [doc("lib/runtime/test-support/fixture.ts", "// @deprecated")];
    expect(
      collectDeprecatedArchitectureViolations(documents, allowlist),
      "目录前缀不得豁免，必须精确到文件",
    ).toContain("lib/runtime/test-support/fixture.ts");
  });
});

/**
 * 专题：Architecture Gate 23.2 边界规则（纯规则模块）。
 *
 * API：
 *   collectHarnessAgentBoundaryViolations(documents: readonly SourceDocument[]) => string[]
 *
 * 返回违规 path，保持输入顺序、唯一。规则定义文件 scripts/architecture-gate.ts 与
 * scripts/architecture-gate-rules.ts 精确排除（按文件，非目录豁免）；注释剥离后仅对
 * 可执行代码匹配。
 */

describe("collectHarnessAgentBoundaryViolations", () => {
  it("Thread.primaryAgentId 与 primary_agent_id 均违规", () => {
    const documents = [
      doc("lib/runtime/thread.ts", "const t: Thread = { primaryAgentId: 'a1' };"),
      doc("lib/runtime/thread-snake.ts", "const t: Thread = { primary_agent_id: 'a1' };"),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("lib/runtime/thread.ts");
    expect(violations).toContain("lib/runtime/thread-snake.ts");
  });

  it("app/api/v1/threads/route.ts 可执行代码出现 agent_id 字段即违规（required）", () => {
    const documents = [
      doc("app/api/v1/threads/route.ts", "type Body = { agent_id: string; title: string };"),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "app/api/v1/threads/route.ts",
    );
  });

  it("app/api/v1/threads/route.ts 可执行代码出现 agent_id 字段即违规（optional 不豁免）", () => {
    const documents = [doc("app/api/v1/threads/route.ts", "type Body = { agent_id?: string };")];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "app/api/v1/threads/route.ts",
    );
  });

  it("agent_id 规则仅针对 app/api/v1/threads/route.ts，不扩大到其他文件", () => {
    const documents = [doc("app/api/v1/agents/route.ts", "type Body = { agent_id?: string };")];
    expect(collectHarnessAgentBoundaryViolations(documents)).not.toContain(
      "app/api/v1/agents/route.ts",
    );
  });

  it("DEFAULT_AGENT_KEY / seedDefaultAgent / defaultAgentId 各自违规", () => {
    const documents = [
      doc("lib/runtime/defaults.ts", "export const DEFAULT_AGENT_KEY = 'default';"),
      doc("lib/runtime/seed.ts", "function seedDefaultAgent() { return; }"),
      doc("lib/runtime/creator.ts", "const defaultAgentId = null;"),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("lib/runtime/defaults.ts");
    expect(violations).toContain("lib/runtime/seed.ts");
    expect(violations).toContain("lib/runtime/creator.ts");
  });

  it("B1 schema 继续暴露旧 Thread 状态或转出正式 Authority Schema 时违规", () => {
    const documents = [
      doc(
        "lib/db/schema.ts",
        'export const THREAD_STATUSES = ["idle"]; export * from "@/lib/persistence/schema/agents";',
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain("lib/db/schema.ts");
  });

  it("本地 Runtime resolver 接受 Thread/Skill Runtime 选择时违规", () => {
    const documents = [
      doc(
        "lib/runtime/resolver.ts",
        "export function resolveRuntimeTypeForThread(thread) { return thread?.runtimeType; }",
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain("lib/runtime/resolver.ts");
  });

  it("agentKey === 'default' fallback 违规", () => {
    const documents = [doc("lib/runtime/selector.ts", "if (agentKey === 'default') { select(); }")];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain("lib/runtime/selector.ts");
  });

  it("threadId === 'new'、JSX threadId=\"new\"、JSX threadId={'new'} 各自违规", () => {
    const documents = [
      doc("app/harness/list.tsx", "if (threadId === 'new') return;"),
      doc("app/harness/row-a.tsx", 'const a = <ThreadRow threadId="new" />;'),
      doc("app/harness/row-b.tsx", "const b = <ThreadRow threadId={'new'} />;"),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("app/harness/list.tsx");
    expect(violations).toContain("app/harness/row-a.tsx");
    expect(violations).toContain("app/harness/row-b.tsx");
  });

  it("'/chat/new' 与 '/desktop/new' 字符串违规", () => {
    const documents = [
      doc("lib/router/chat.ts", "const p = '/chat/new';"),
      doc("lib/router/desktop.ts", "const q = '/desktop/new';"),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("lib/router/chat.ts");
    expect(violations).toContain("lib/router/desktop.ts");
  });

  it("route.kind === 'chat' 在正式消费者违规", () => {
    const documents = [
      doc("components/thread-launcher.ts", "if (route.kind === 'chat') { launch(); }"),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "components/thread-launcher.ts",
    );
  });

  it("lib/routes 内 kind: 'chat' 违规", () => {
    const documents = [doc("lib/routes/chat-route.ts", "const route = { kind: 'chat' };")];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain("lib/routes/chat-route.ts");
  });

  it("Agent target 与 Runtime evidence 同对象构造违规", () => {
    const documents = [
      doc(
        "lib/routes/projection/legacy-agent-route.ts",
        'const row = { targetKind: "agent", runtimeRevisionId: "runtime-1" };',
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "lib/routes/projection/legacy-agent-route.ts",
    );
  });

  it("Agent target fallback 到 Runtime target 违规", () => {
    const documents = [
      doc(
        "lib/routes/application/fallback.ts",
        'const target = input.target === "agent" ? { kind: "runtime" } : input.target;',
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "lib/routes/application/fallback.ts",
    );
  });

  it("RouteSet 唯一索引依赖 nullable agentId 违规", () => {
    const documents = [
      doc(
        "lib/persistence/schema/deployment-route.ts",
        'uniqueIndex("uq").on(table.tenantId, table.agentId, table.routeScopeKey);',
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "lib/persistence/schema/deployment-route.ts",
    );
  });

  it("RouteSet 对外合同用 nullable agent 字段表达 target 违规", () => {
    const documents = [
      doc(
        "lib/control-plane-client/contracts/route.ts",
        "export interface RouteSetDTO { agent_id?: string | null }",
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "lib/control-plane-client/contracts/route.ts",
    );
  });

  it("根据 nullable agentId 推断 Route target 违规", () => {
    const documents = [
      doc(
        "lib/routes/application/infer-target.ts",
        'const target = agentId ? { kind: "agent" } : { kind: "runtime" };',
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "lib/routes/application/infer-target.ts",
    );
  });

  it("Route activation 与 eligibility projection 绕唯一 Store 直接写入时违规", () => {
    const documents = [
      doc(
        "lib/routes/application/direct-activation.ts",
        "db.update(deploymentRouteTable).set({ activeRouteRevisionId });",
      ),
      doc(
        "lib/routes/application/direct-projection.ts",
        "db.insert(routeEligibilityProjectionTable).values(row);",
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toEqual([
      "lib/routes/application/direct-activation.ts",
      "lib/routes/application/direct-projection.ts",
    ]);
  });

  it("agents.length === 0 后 return/throw 的执行阻断违规", () => {
    const documents = [
      doc("app/desktop/harness.tsx", "if (agents.length === 0) return;"),
      doc("app/desktop/harness-throw.tsx", "if (agents.length === 0) throw new Error('none');"),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("app/desktop/harness.tsx");
    expect(violations).toContain("app/desktop/harness-throw.tsx");
  });

  it('/test-support/ 不整体豁免：helper.ts 中 threadId="new" 违规', () => {
    const documents = [doc("lib/test-support/helper.ts", 'const id = threadId="new";')];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "lib/test-support/helper.ts",
    );
  });

  it('.test.ts/.test.tsx 可排除（含 threadId="new"）', () => {
    const documents = [
      doc("lib/runtime/example.test.ts", 'const id = threadId="new";'),
      doc("lib/runtime/example.test.tsx", "const id = threadId={'new'};"),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toEqual([]);
  });

  it("注释中的边界词不应违规", () => {
    const documents = [
      doc(
        "lib/runtime/doc-note.ts",
        "// primaryAgentId 与 DEFAULT_AGENT_KEY 已退役，agentKey === 'default' 禁用，threadId=\"new\" 为假路由，'/chat/new' 不应使用。",
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toEqual([]);
  });

  it("规则定义文件精确排除：scripts/architecture-gate.ts", () => {
    const documents = [
      doc(
        "scripts/architecture-gate.ts",
        "// primaryAgentId DEFAULT_AGENT_KEY agentKey === 'default' threadId=\"new\" '/chat/new' agents.length === 0 return",
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toEqual([]);
  });

  it("规则定义文件精确排除：scripts/architecture-gate-rules.ts", () => {
    const documents = [
      doc("scripts/architecture-gate-rules.ts", "const p = 'primaryAgentId DEFAULT_AGENT_KEY';"),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toEqual([]);
  });

  it("正常基础 Harness 代码无违规", () => {
    const documents = [
      doc(
        "lib/runtime/execution-engine.ts",
        [
          "const constraint: HarnessConstraint = { target: { kind: 'runtime' }, threadId: null };",
          "let threadId: string | null = null;",
          "if (route.kind === 'thread') { run(threadId); }",
          "const target = '/chat/thread';",
        ].join("\n"),
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toEqual([]);
  });
});

// ─── A2A AgentCall 边界 ──────────────────────────────────

/**
 * Gate 必须拒绝任何旧 A2A Runtime authority 与双轨残留，
 * 而合法 AgentCall A2A（lib/agents/calls/transport/a2a/…）必须通过。
 * 字段检查（runtimeExecutionRef/runtimeSessionRef）仅绑定 AgentCall
 * transport 作用域，合法 Harness runtime 字段不受牵连。
 */

describe("collectHarnessAgentBoundaryViolations A2A AgentCall boundary", () => {
  it("旧 A2A Runtime 文件 lib/runtime/transport/a2a-transport.ts 即使内容无关紧要也违规", () => {
    const documents = [doc("lib/runtime/transport/a2a-transport.ts", "export const VERSION = 1;")];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "lib/runtime/transport/a2a-transport.ts",
    );
  });

  it("runtime a2a 后台失败处理器违规", () => {
    const documents = [
      doc(
        "lib/runtime/transport/a2a-background-failure-handler.ts",
        "export class A2ABackgroundFailureHandler { handle(err: Error): void {} }",
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "lib/runtime/transport/a2a-background-failure-handler.ts",
    );
  });

  it("runtime a2a protocol enum/assignment 违规：schema RUNTIME_PROTOCOL_TYPES 含 a2a、runtime 生产 protocolType 赋值 a2a", () => {
    // schema 已知 RUNTIME_PROTOCOL_TYPES 不得含 a2a。
    const schema = doc(
      "lib/persistence/schema/runtimes.ts",
      'export const RUNTIME_PROTOCOL_TYPES = ["harness_runtime_protocol", "a2a"] as const;',
    );
    expect(collectHarnessAgentBoundaryViolations([schema])).toContain(
      "lib/persistence/schema/runtimes.ts",
    );
    // runtime 生产 protocolType 赋值不得为 a2a（文件名不含 a2a，靠赋值规则判别）。
    const registration = doc("lib/runtime/registration.ts", 'const r = { protocolType: "a2a" };');
    expect(collectHarnessAgentBoundaryViolations([registration])).toContain(
      "lib/runtime/registration.ts",
    );
    // 合法 AgentContractSnapshot protocolType a2a 仍允许。
    const agentSnapshot = doc(
      "lib/agents/domain/agent-contract-snapshot.ts",
      'export const snapshot = { protocolType: "a2a" as const };',
    );
    expect(collectHarnessAgentBoundaryViolations([agentSnapshot])).toEqual([]);
  });

  it("app/lib 从旧 a2a transport import/export 违规", () => {
    const documents = [
      doc(
        "app/api/v1/runtime/ingest/route.ts",
        'import { A2AMessage } from "@/lib/runtime/transport/a2a-transport";',
      ),
      doc(
        "lib/agents/gateway.ts",
        'export { A2AResponse } from "@/lib/runtime/transport/a2a-transport";',
      ),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("app/api/v1/runtime/ingest/route.ts");
    expect(violations).toContain("lib/agents/gateway.ts");
  });

  it("A2AEventBatchSink 与 A2ARuntimeRefResolver 标识符违规", () => {
    const documents = [
      doc("lib/runtime/sink.ts", "export const sink = new A2AEventBatchSink();"),
      doc("lib/runtime/resolver.ts", "export const resolver = new A2ARuntimeRefResolver();"),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("lib/runtime/sink.ts");
    expect(violations).toContain("lib/runtime/resolver.ts");
  });

  it("lib/agents/calls/transport 内 RuntimeHttpClient 实现/import 违规", () => {
    const documents = [
      doc(
        "lib/agents/calls/transport/runtime-http-client.ts",
        "export class RuntimeHttpClient { post(): Promise<Response> { return fetch(''); } }",
      ),
      doc(
        "lib/agents/calls/transport/a2a/x.ts",
        'import { RuntimeHttpClient } from "../runtime-http-client";',
      ),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("lib/agents/calls/transport/runtime-http-client.ts");
    expect(violations).toContain("lib/agents/calls/transport/a2a/x.ts");
  });

  it("AgentCall transport 作用域写 runtimeExecutionRef/runtimeSessionRef 违规", () => {
    const documents = [
      doc("lib/agents/calls/transport/a2a/y.ts", "const ref = { runtimeExecutionRef: 're1' };"),
      doc("lib/agents/calls/transport/a2a/z.ts", "const ref = { runtimeSessionRef: 'rs1' };"),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("lib/agents/calls/transport/a2a/y.ts");
    expect(violations).toContain("lib/agents/calls/transport/a2a/z.ts");
  });

  it("AgentCall resolution 读取 runtimeRevisionId 违规", () => {
    const documents = [
      doc(
        "lib/agents/calls/application/resolve-agent-call-binding.ts",
        "const revisionId = resolution.runtimeRevisionId;",
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toContain(
      "lib/agents/calls/application/resolve-agent-call-binding.ts",
    );
  });

  it("合法 Harness runtime 字段不受 AgentCall 作用域约束牵连", () => {
    const documents = [
      doc("lib/runtime/session-binding.ts", "const ref = { runtimeSessionRef: 'rs1' };"),
      doc("lib/runtime/execution-ref.ts", "const ref = { runtimeExecutionRef: 're1' };"),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toEqual([]);
  });

  it("AgentCall transport 从 runtime event-ingress 或 recovery/markInvocationLost import 违规", () => {
    const documents = [
      doc(
        "lib/agents/calls/transport/a2a/ingest.ts",
        'import { EventIngress } from "@/lib/runtime/event-ingress";',
      ),
      doc(
        "lib/agents/calls/transport/a2a/recover.ts",
        'import { markInvocationLost } from "@/lib/runtime/recovery";',
      ),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("lib/agents/calls/transport/a2a/ingest.ts");
    expect(violations).toContain("lib/agents/calls/transport/a2a/recover.ts");
  });

  it("从旧 A2A 路径 reexport/alias 禁止", () => {
    const documents = [
      doc(
        "lib/agents/calls/transport/a2a/bridge.ts",
        'export { A2ARequest } from "@/lib/runtime/transport/a2a-transport";',
      ),
      doc(
        "lib/agents/calls/transport/a2a/alias.ts",
        'import a2a = require("@/lib/runtime/transport/a2a-transport");',
      ),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("lib/agents/calls/transport/a2a/bridge.ts");
    expect(violations).toContain("lib/agents/calls/transport/a2a/alias.ts");
  });

  it("合法 lib/agents/calls/transport/a2a/a2a-client.ts 与 ingress 自有 AgentCall 类型通过", () => {
    const documents = [
      doc(
        "lib/agents/calls/transport/a2a/a2a-client.ts",
        'import type { AgentCallRequest, AgentCallResponse } from "@/lib/agents/calls/domain/agent-call-types";\nexport class A2AClient { async send(req: AgentCallRequest): Promise<AgentCallResponse> { return { ok: true }; } }',
      ),
      doc(
        "lib/agents/calls/transport/a2a/ingress.ts",
        'export interface AgentCallIngressEvent { kind: "agent_call"; id: string; }',
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(documents)).toEqual([]);
  });

  it("注释记录被禁边界接受（除非文件名自身被禁）", () => {
    const commentOnly = [
      doc(
        "lib/agents/calls/transport/a2a/note.ts",
        "// A2ARuntimeRefResolver、markInvocationLost、a2a-transport 均被禁，AgentCall 不再绑定 runtime ExecutionRef。",
      ),
    ];
    expect(collectHarnessAgentBoundaryViolations(commentOnly)).toEqual([]);

    // 文件名自身为旧 A2A Runtime 残留则即使全注释也违规。
    const forbiddenFile = [
      doc("lib/runtime/transport/a2a-transport.ts", "// 已被 AgentCall A2A 取代，本文件仅作注释。"),
    ];
    expect(collectHarnessAgentBoundaryViolations(forbiddenFile)).toContain(
      "lib/runtime/transport/a2a-transport.ts",
    );
  });

  it("test-support 不整体豁免：AgentCall transport 作用域内字段/旧残留仍扫", () => {
    const documents = [
      doc(
        "lib/agents/calls/test-support/a2a-client-helper.ts",
        'import { A2ARequest } from "@/lib/runtime/transport/a2a-transport";',
      ),
      doc(
        "lib/agents/calls/test-support/transport-helper.ts",
        "const ref = { runtimeExecutionRef: 're1' };",
      ),
    ];
    const violations = collectHarnessAgentBoundaryViolations(documents);
    expect(violations).toContain("lib/agents/calls/test-support/a2a-client-helper.ts");
    expect(violations).toContain("lib/agents/calls/test-support/transport-helper.ts");
  });
});

// ─── Execution wire 与特例分支边界 ────────────────────────

describe("collectExecutionBoundaryViolations", () => {
  it("生产 A2A wire 出现 snowharness.execution_subject → 违规", () => {
    const documents = [
      doc("lib/runtime/transport/a2a-transport.ts", 'const key = "snowharness.execution_subject";'),
    ];
    expect(collectExecutionBoundaryViolations(documents)).toEqual([
      {
        path: "lib/runtime/transport/a2a-transport.ts",
        title: "namespaced execution_subject wire",
      },
    ]);
  });

  it("subject_kind 裸 service 输出 → 违规；platform_service 合法", () => {
    const bad = doc(
      "lib/runtime/transport/x.ts",
      'const subject = { subject_kind: subjectType === "service" ? "service" : "platform_user" };',
    );
    expect(collectExecutionBoundaryViolations([bad])).toEqual([
      { path: "lib/runtime/transport/x.ts", title: "subject_kind 裸 service 输出" },
    ]);
    const good = doc(
      "lib/runtime/transport/x.ts",
      'const subject = { subject_kind: "platform_service" };',
    );
    expect(collectExecutionBoundaryViolations([good])).toEqual([]);
  });

  it("Studio 生产自行构造 conformance_run_id 字面量 → 违规；DTO 值合法", () => {
    const bad = doc("components/studio/panel.tsx", 'conformance_run_id: "conf-1",');
    expect(collectExecutionBoundaryViolations([bad])).toEqual([
      {
        path: "components/studio/panel.tsx",
        title: "Studio/生产自行构造 conformance_run_id 字面量",
      },
    ]);
    const good = doc(
      "components/studio/panel.tsx",
      'conformance_run_id: revision.latest_valid_conformance_run_id ?? "",',
    );
    expect(collectExecutionBoundaryViolations([good])).toEqual([]);
  });

  it("HR 特例分支（hr-assistant/veadk/8100）→ 违规；fixture 精确白名单跳过", () => {
    expect(
      collectExecutionBoundaryViolations([
        doc("lib/runtime/x.ts", 'if (agent === "hr-assistant") { }'),
      ]),
    ).toHaveLength(1);
    expect(
      collectExecutionBoundaryViolations([doc("lib/runtime/x.ts", "const port = 8100;")]),
    ).toHaveLength(1);
    expect(
      collectExecutionBoundaryViolations([
        doc("lib/agents/test-support/hr-agent-contract.ts", 'id: "hr-assistant"'),
      ]),
    ).toEqual([]);
  });

  it(".test.* 文件与注释不违规", () => {
    const documents = [
      doc("lib/runtime/x.test.ts", 'const key = "snowharness.execution_subject";'),
      doc("lib/runtime/x.ts", "// 注释中的 hr-assistant 不算"),
    ];
    expect(collectExecutionBoundaryViolations(documents)).toEqual([]);
  });
});

describe("checkResumeTruthfulnessGate", () => {
  const RESOLVE_ROUTE = "app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route.ts";
  const A2A = "lib/agents/calls/transport/a2a/a2a-client.ts";

  it("catch 吞错 + 无 resume_dispatch → 失败", () => {
    const result = checkResumeTruthfulnessGate([
      doc(
        RESOLVE_ROUTE,
        "await dispatchResumeCommandToRuntime({...}).catch((err) => logger.warn(err)); return ok(200);",
      ),
      doc(A2A, "async resumeCall(req) { send(req); }"),
    ]);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(3);
  });

  it("真实结果投影 + 公共 metadata mapper → 通过", () => {
    const result = checkResumeTruthfulnessGate([
      doc(
        RESOLVE_ROUTE,
        "const gatewayResult = await dispatchResumeCommandToRuntime({...}); const responseBody = { resume_dispatch };",
      ),
      doc(
        A2A,
        "async resumeCall(req) { const m = buildA2APublicMessageMetadata(req.requestBody.invocation_context); }",
      ),
    ]);
    expect(result).toEqual({ passed: true, failures: [] });
  });
});

// ─── Dispatch 与 Recovery Authority ───────────────────────

describe("checkDispatchRecoveryAuthorityGate", () => {
  const PATHS = {
    commandDispatcher: "lib/runtime/command-dispatcher.ts",
    dispatcher: "lib/runtime/dispatcher.ts",
    attemptService: "lib/runtime/retry/dispatch-queued-invocation-attempt.ts",
    recovery: "lib/runtime/recovery-queries.ts",
    resolveRoute: "app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route.ts",
    transport: "lib/agents/calls/transport/a2a/a2a-client.ts",
    parser: "lib/agents/domain/public-agent-contract.ts",
  };

  function compliantDocs(): SourceDocument[] {
    return [
      doc(PATHS.commandDispatcher, "scheduleCommandTransientRetry({});"),
      doc(PATHS.dispatcher, "recordAttemptDispatchTransientFailure({});"),
      doc(PATHS.attemptService, "recordAttemptDispatchTransientFailure({});"),
      doc(
        PATHS.recovery,
        'import { markSessionBindingLostInSession } from "@/lib/runtime/session-binding-queries"; markSessionBindingLostInSession(tx, id);',
      ),
      doc(
        PATHS.resolveRoute,
        [
          'if (gatewayResult.reason === "protocol_not_remote") { mode: "local_runtime" }',
          'if (gatewayResult.reason === "unsupported_capability") { return 422; }',
          'if (gatewayResult.reason === "command_not_found") { return 409; }',
        ].join("\n"),
      ),
      doc(
        PATHS.transport,
        "runtime_session_ref: contextId, capabilities: { features: { cancel: params.capabilities.cancel, resume: params.capabilities.resume, user_action: params.capabilities.user_action ?? false } }",
      ),
      doc(
        PATHS.parser,
        'throw new PublicAgentContractError("interaction.input_required=true 要求 interaction.resume=true");',
      ),
    ];
  }

  it("全部合规 → 通过", () => {
    const result = checkDispatchRecoveryAuthorityGate(compliantDocs());
    expect(result).toEqual({ passed: true, failures: [] });
  });

  it("缺 retry owner → 失败", () => {
    const docs = compliantDocs().map((d) =>
      d.path === PATHS.commandDispatcher ? doc(d.path, "return skipped;") : d,
    );
    const result = checkDispatchRecoveryAuthorityGate(docs);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("scheduleCommandTransientRetry"))).toBe(true);
  });

  it("recovery 使用全局 markSessionBindingLost → 失败", () => {
    const docs = compliantDocs().map((d) =>
      d.path === PATHS.recovery
        ? doc(
            d.path,
            'import { markSessionBindingLost } from "@/lib/runtime/session-binding-queries";',
          )
        : d,
    );
    const result = checkDispatchRecoveryAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("全局 db 版本"))).toBe(true);
  });

  it("缺 command_not_found 显式分支 → 失败", () => {
    const docs = compliantDocs().map((d) =>
      d.path === PATHS.resolveRoute
        ? doc(
            d.path,
            'if (gatewayResult.reason === "protocol_not_remote") {} if (gatewayResult.reason === "unsupported_capability") {}',
          )
        : d,
    );
    const result = checkDispatchRecoveryAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("command_not_found"))).toBe(true);
  });

  it("硬编码 user_action=true → 失败", () => {
    const docs = compliantDocs().map((d) =>
      d.path === PATHS.transport
        ? doc(d.path, "runtime_session_ref: contextId, features: { user_action: true }")
        : d,
    );
    const result = checkDispatchRecoveryAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("硬编码"))).toBe(true);
  });

  it("Parser 缺 input_required/resume 约束 → 失败", () => {
    const docs = compliantDocs().map((d) =>
      d.path === PATHS.parser ? doc(d.path, "return flags;") : d,
    );
    const result = checkDispatchRecoveryAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("语义约束"))).toBe(true);
  });
});

// ─── Agent execution Authority ────────────────────────────

describe("checkAgentExecutionAuthorityGate", () => {
  /** 合规 fixture：旧 Authority 归零 + AgentCall child domain 存在。 */
  function compliantDocs(): SourceDocument[] {
    return [
      doc("lib/persistence/schema/executions.ts", "runtimeRevisionId: varchar(...);"),
      doc(
        "lib/persistence/schema/runtimes.ts",
        "protocolType: mysqlEnum('harness_runtime_protocol');",
      ),
      doc("lib/runtime/runtime-client.ts", "capability_type: 'agent'; mode: 'preferred';"),
      doc("lib/agents/calls/domain/agent-call.ts", "parentInvocationId: string;"),
      doc("lib/persistence/schema/agent-calls.ts", "parentInvocationId: varchar(...);"),
      doc("lib/agents/calls/transport/a2a/a2a-mapper.ts", "A2A completed -> AgentCall.completed;"),
    ];
  }

  it("合规代码 → passed", () => {
    const result = checkAgentExecutionAuthorityGate(compliantDocs());
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("ExecutionBinding schema 出现 Agent evidence 列 → 失败", () => {
    const docs = compliantDocs().map((d) =>
      d.path === "lib/persistence/schema/executions.ts"
        ? doc(d.path, "agentRevisionId: varchar(...); agentPublicationRecordId: varchar(...);")
        : d,
    );
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("ExecutionBinding"))).toBe(true);
  });

  it("RuntimeRevision schema 出现 Agent/A2A contract authority → 失败", () => {
    const docs = compliantDocs().map((d) =>
      d.path === "lib/persistence/schema/runtimes.ts"
        ? doc(d.path, "agentContractSnapshotId: varchar(...);")
        : d,
    );
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("RuntimeRevision"))).toBe(true);
  });

  it("Runtime Start Request 出现 agent_instruction_ref → 失败", () => {
    const docs = compliantDocs().map((d) =>
      d.path === "lib/runtime/runtime-client.ts" ? doc(d.path, "agent_instruction_ref: '...';") : d,
    );
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("Runtime Start Request"))).toBe(true);
  });

  it("旧 Agent 选择与 required capability 标识符重新出现 → 失败", () => {
    const docs = [
      ...compliantDocs(),
      doc(
        "lib/runtime/legacy-start.ts",
        "const capability_requirements = [{ capability_type: 'agent', mode: 'required' }];",
      ),
      doc(
        "lib/conversations/legacy-turn.ts",
        "const requestedAgentId = turn.requestedAgentId; const agentSelectionMode = 'required';",
      ),
      doc("app/api/v1/legacy/route.ts", "const wireKey = 'agent_selection';"),
    ];
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("旧 Agent 选择协议"))).toBe(true);
  });

  it("Runtime adapter start 参数出现 agentRevisionId → 失败", () => {
    const docs = [
      ...compliantDocs(),
      doc(
        "lib/runtime/adapters/hosted-adapter.ts",
        "interface StartInvocationParams { agentRevisionId: string | null }",
      ),
    ];
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("agentRevisionId"))).toBe(true);
  });

  it("HostedAgentLoop → 失败", () => {
    const docs = [
      ...compliantDocs(),
      doc("lib/runtime/adapters/hosted-adapter.ts", "class HostedAgentLoop {}"),
    ];
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("HostedAgentLoop"))).toBe(true);
  });

  it("顶层 ThreadItem agent_message → 失败", () => {
    const docs = [
      ...compliantDocs(),
      doc("lib/persistence/schema/conversation.ts", "itemType: 'agent_message'"),
    ];
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("agent_message"))).toBe(true);
  });

  it("第二套 Resolver（resolveAgentRoute）→ 失败", () => {
    const docs = [
      ...compliantDocs(),
      doc(
        "lib/routes/application/resolve-agent-route.ts",
        "export function resolveAgentRoute() {}",
      ),
    ];
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("Route Resolver"))).toBe(true);
  });

  it("AgentCall domain 缺 parentInvocationId → 失败", () => {
    const docs = compliantDocs().map((d) =>
      d.path === "lib/agents/calls/domain/agent-call.ts" ? doc(d.path, "agentId: string;") : d,
    );
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("parentInvocationId"))).toBe(true);
  });

  it("A2A transport 直接改 parent Invocation 终态 → 失败", () => {
    const docs = [
      ...compliantDocs(),
      doc(
        "lib/agents/calls/transport/a2a/a2a-client.ts",
        "markInvocationCompleted(parentInvocationId);",
      ),
    ];
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.failures.some((f) => f.includes("parent Invocation"))).toBe(true);
  });

  it("禁词在注释中 → 不违规（剥离注释）", () => {
    const docs = [
      ...compliantDocs(),
      doc("lib/runtime/dispatcher.ts", "// 旧的 HostedAgentLoop 已移除，现在用 Harness Loop"),
    ];
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.passed).toBe(true);
  });

  it("测试文件可构造旧场景 → 不违规（排除 .test.*）", () => {
    const docs = [
      ...compliantDocs(),
      doc("lib/runtime/adapters/hosted-adapter.test.ts", "class HostedAgentLoop {}"),
    ];
    const result = checkAgentExecutionAuthorityGate(docs);
    expect(result.passed).toBe(true);
  });
});
