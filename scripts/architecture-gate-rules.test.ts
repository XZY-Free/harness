import { describe, expect, it } from "vitest";
import {
  type SourceDocument,
  checkResumeTruthfulnessGate,
  checkRuntimeRegistrationEvidence,
  collectCloseoutBoundaryViolations,
  collectDeprecatedArchitectureViolations,
  collectTopic01BoundaryViolations,
} from "./architecture-gate-rules";

/**
 * 专题：Architecture Gate 的 deprecated/legacy 检查边界（纯规则模块）。
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
 *   collectTopic01BoundaryViolations(documents: readonly SourceDocument[]) => string[]
 *
 * 返回违规 path，保持输入顺序、唯一。规则定义文件 scripts/architecture-gate.ts 与
 * scripts/architecture-gate-rules.ts 精确排除（按文件，非目录豁免）；注释剥离后仅对
 * 可执行代码匹配。
 */

describe("collectTopic01BoundaryViolations", () => {
  it("Thread.primaryAgentId 与 primary_agent_id 均违规", () => {
    const documents = [
      doc("lib/runtime/thread.ts", "const t: Thread = { primaryAgentId: 'a1' };"),
      doc("lib/runtime/thread-snake.ts", "const t: Thread = { primary_agent_id: 'a1' };"),
    ];
    const violations = collectTopic01BoundaryViolations(documents);
    expect(violations).toContain("lib/runtime/thread.ts");
    expect(violations).toContain("lib/runtime/thread-snake.ts");
  });

  it("app/api/v1/threads/route.ts 可执行代码出现 agent_id 字段即违规（required）", () => {
    const documents = [
      doc("app/api/v1/threads/route.ts", "type Body = { agent_id: string; title: string };"),
    ];
    expect(collectTopic01BoundaryViolations(documents)).toContain("app/api/v1/threads/route.ts");
  });

  it("app/api/v1/threads/route.ts 可执行代码出现 agent_id 字段即违规（optional 不豁免）", () => {
    const documents = [doc("app/api/v1/threads/route.ts", "type Body = { agent_id?: string };")];
    expect(collectTopic01BoundaryViolations(documents)).toContain("app/api/v1/threads/route.ts");
  });

  it("agent_id 规则仅针对 app/api/v1/threads/route.ts，不扩大到其他文件", () => {
    const documents = [doc("app/api/v1/agents/route.ts", "type Body = { agent_id?: string };")];
    expect(collectTopic01BoundaryViolations(documents)).not.toContain("app/api/v1/agents/route.ts");
  });

  it("DEFAULT_AGENT_KEY / seedDefaultAgent / defaultAgentId 各自违规", () => {
    const documents = [
      doc("lib/runtime/defaults.ts", "export const DEFAULT_AGENT_KEY = 'default';"),
      doc("lib/runtime/seed.ts", "function seedDefaultAgent() { return; }"),
      doc("lib/runtime/creator.ts", "const defaultAgentId = null;"),
    ];
    const violations = collectTopic01BoundaryViolations(documents);
    expect(violations).toContain("lib/runtime/defaults.ts");
    expect(violations).toContain("lib/runtime/seed.ts");
    expect(violations).toContain("lib/runtime/creator.ts");
  });

  it("agentKey === 'default' fallback 违规", () => {
    const documents = [doc("lib/runtime/selector.ts", "if (agentKey === 'default') { select(); }")];
    expect(collectTopic01BoundaryViolations(documents)).toContain("lib/runtime/selector.ts");
  });

  it("threadId === 'new'、JSX threadId=\"new\"、JSX threadId={'new'} 各自违规", () => {
    const documents = [
      doc("app/harness/list.tsx", "if (threadId === 'new') return;"),
      doc("app/harness/row-a.tsx", 'const a = <ThreadRow threadId="new" />;'),
      doc("app/harness/row-b.tsx", "const b = <ThreadRow threadId={'new'} />;"),
    ];
    const violations = collectTopic01BoundaryViolations(documents);
    expect(violations).toContain("app/harness/list.tsx");
    expect(violations).toContain("app/harness/row-a.tsx");
    expect(violations).toContain("app/harness/row-b.tsx");
  });

  it("'/chat/new' 与 '/desktop/new' 字符串违规", () => {
    const documents = [
      doc("lib/router/chat.ts", "const p = '/chat/new';"),
      doc("lib/router/desktop.ts", "const q = '/desktop/new';"),
    ];
    const violations = collectTopic01BoundaryViolations(documents);
    expect(violations).toContain("lib/router/chat.ts");
    expect(violations).toContain("lib/router/desktop.ts");
  });

  it("route.kind === 'chat' 在正式消费者违规", () => {
    const documents = [
      doc("components/thread-launcher.ts", "if (route.kind === 'chat') { launch(); }"),
    ];
    expect(collectTopic01BoundaryViolations(documents)).toContain("components/thread-launcher.ts");
  });

  it("lib/routes 内 kind: 'chat' 违规", () => {
    const documents = [doc("lib/routes/chat-route.ts", "const route = { kind: 'chat' };")];
    expect(collectTopic01BoundaryViolations(documents)).toContain("lib/routes/chat-route.ts");
  });

  it("agents.length === 0 后 return/throw 的执行阻断违规", () => {
    const documents = [
      doc("app/desktop/harness.tsx", "if (agents.length === 0) return;"),
      doc("app/desktop/harness-throw.tsx", "if (agents.length === 0) throw new Error('none');"),
    ];
    const violations = collectTopic01BoundaryViolations(documents);
    expect(violations).toContain("app/desktop/harness.tsx");
    expect(violations).toContain("app/desktop/harness-throw.tsx");
  });

  it('/test-support/ 不整体豁免：helper.ts 中 threadId="new" 违规', () => {
    const documents = [doc("lib/test-support/helper.ts", 'const id = threadId="new";')];
    expect(collectTopic01BoundaryViolations(documents)).toContain("lib/test-support/helper.ts");
  });

  it('.test.ts/.test.tsx 可排除（含 threadId="new"）', () => {
    const documents = [
      doc("lib/runtime/example.test.ts", 'const id = threadId="new";'),
      doc("lib/runtime/example.test.tsx", "const id = threadId={'new'};"),
    ];
    expect(collectTopic01BoundaryViolations(documents)).toEqual([]);
  });

  it("注释中的边界词不应违规", () => {
    const documents = [
      doc(
        "lib/runtime/doc-note.ts",
        "// primaryAgentId 与 DEFAULT_AGENT_KEY 已退役，agentKey === 'default' 禁用，threadId=\"new\" 为假路由，'/chat/new' 不应使用。",
      ),
    ];
    expect(collectTopic01BoundaryViolations(documents)).toEqual([]);
  });

  it("规则定义文件精确排除：scripts/architecture-gate.ts", () => {
    const documents = [
      doc(
        "scripts/architecture-gate.ts",
        "// primaryAgentId DEFAULT_AGENT_KEY agentKey === 'default' threadId=\"new\" '/chat/new' agents.length === 0 return",
      ),
    ];
    expect(collectTopic01BoundaryViolations(documents)).toEqual([]);
  });

  it("规则定义文件精确排除：scripts/architecture-gate-rules.ts", () => {
    const documents = [
      doc("scripts/architecture-gate-rules.ts", "const p = 'primaryAgentId DEFAULT_AGENT_KEY';"),
    ];
    expect(collectTopic01BoundaryViolations(documents)).toEqual([]);
  });

  it("正常基础 Harness 代码无违规", () => {
    const documents = [
      doc(
        "lib/runtime/execution-engine.ts",
        [
          "const constraint: HarnessConstraint = { agentConstraint: null, threadId: null };",
          "let threadId: string | null = null;",
          "if (route.kind === 'thread') { run(threadId); }",
          "const target = '/chat/thread';",
        ].join("\n"),
      ),
    ];
    expect(collectTopic01BoundaryViolations(documents)).toEqual([]);
  });
});

// ─── 剩余代码收口（V12/01 08 专项）规则 ────────────────────

describe("collectCloseoutBoundaryViolations（E1-E4）", () => {
  it("E1：生产 A2A wire 出现 snowharness.execution_subject → 违规", () => {
    const documents = [
      doc("lib/runtime/transport/a2a-transport.ts", 'const key = "snowharness.execution_subject";'),
    ];
    expect(collectCloseoutBoundaryViolations(documents)).toEqual([
      {
        path: "lib/runtime/transport/a2a-transport.ts",
        title: "E1 旧 namespaced execution_subject wire",
      },
    ]);
  });

  it("E2：subject_kind 裸 service 输出 → 违规；platform_service 合法", () => {
    const bad = doc(
      "lib/runtime/transport/x.ts",
      'const subject = { subject_kind: subjectType === "service" ? "service" : "platform_user" };',
    );
    expect(collectCloseoutBoundaryViolations([bad])).toEqual([
      { path: "lib/runtime/transport/x.ts", title: "E2 subject_kind 裸 service 输出" },
    ]);
    const good = doc(
      "lib/runtime/transport/x.ts",
      'const subject = { subject_kind: "platform_service" };',
    );
    expect(collectCloseoutBoundaryViolations([good])).toEqual([]);
  });

  it("E3：Studio 生产自行构造 conformance_run_id 字面量 → 违规；DTO 值合法", () => {
    const bad = doc("components/studio/panel.tsx", 'conformance_run_id: "conf-1",');
    expect(collectCloseoutBoundaryViolations([bad])).toEqual([
      {
        path: "components/studio/panel.tsx",
        title: "E3 Studio/生产自行构造 conformance_run_id 字面量",
      },
    ]);
    const good = doc(
      "components/studio/panel.tsx",
      'conformance_run_id: revision.latest_valid_conformance_run_id ?? "",',
    );
    expect(collectCloseoutBoundaryViolations([good])).toEqual([]);
  });

  it("E4：HR 特例分支（hr-assistant/veadk/8100）→ 违规；fixture 精确白名单跳过", () => {
    expect(
      collectCloseoutBoundaryViolations([
        doc("lib/runtime/x.ts", 'if (agent === "hr-assistant") { }'),
      ]),
    ).toHaveLength(1);
    expect(
      collectCloseoutBoundaryViolations([doc("lib/runtime/x.ts", "const port = 8100;")]),
    ).toHaveLength(1);
    expect(
      collectCloseoutBoundaryViolations([
        doc("lib/agents/test-support/hr-agent-contract.ts", 'id: "hr-assistant"'),
      ]),
    ).toEqual([]);
  });

  it(".test.* 文件与注释不违规", () => {
    const documents = [
      doc("lib/runtime/x.test.ts", 'const key = "snowharness.execution_subject";'),
      doc("lib/runtime/x.ts", "// 注释中的 hr-assistant 不算"),
    ];
    expect(collectCloseoutBoundaryViolations(documents)).toEqual([]);
  });
});

describe("checkRuntimeRegistrationEvidence（08 §4）", () => {
  const FULL_SOURCE = [
    'import { buildActiveExternalConformanceReport } from "a";',
    'import { prepareRuntimeConformanceRun } from "b";',
    'import { appendRuntimeConformanceRun } from "c";',
    'import { createMysqlRuntimeConformanceRunSession } from "d";',
  ].join("\n");

  it("完整正式证据链 → 通过", () => {
    expect(
      checkRuntimeRegistrationEvidence([
        doc("lib/runtime/application/register-agent-runtime.ts", FULL_SOURCE),
      ]),
    ).toEqual({ passed: true, failures: [] });
  });

  it("缺失 append/prepare → 失败；import 测试 DSSE builder → 失败", () => {
    const missing = checkRuntimeRegistrationEvidence([
      doc(
        "lib/runtime/application/register-agent-runtime.ts",
        FULL_SOURCE.replace('import { appendRuntimeConformanceRun } from "c";', ""),
      ),
    ]);
    expect(missing.passed).toBe(false);
    const testImport = checkRuntimeRegistrationEvidence([
      doc(
        "lib/runtime/application/register-agent-runtime.ts",
        `${FULL_SOURCE}\nimport { buildDsseConformanceEnvelope } from "@/lib/runtime/test-support/build-dsse-conformance-envelope";`,
      ),
    ]);
    expect(testImport.passed).toBe(false);
  });
});

describe("checkResumeTruthfulnessGate（08 §5）", () => {
  const RESOLVE_ROUTE = "app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route.ts";
  const A2A = "lib/runtime/transport/a2a-transport.ts";

  it("catch 吞错 + 无 resume_dispatch → 失败", () => {
    const result = checkResumeTruthfulnessGate([
      doc(
        RESOLVE_ROUTE,
        "await dispatchResumeCommandToRuntime({...}).catch((err) => logger.warn(err)); return ok(200);",
      ),
      doc(A2A, "async resumeInvocation(req) { send(req); }"),
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
        "async resumeInvocation(req) { const m = buildA2APublicMessageMetadata(req.requestBody.invocation_context); }",
      ),
    ]);
    expect(result).toEqual({ passed: true, failures: [] });
  });
});
