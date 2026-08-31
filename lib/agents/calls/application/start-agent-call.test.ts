/**
 * startAgentCall 应用服务集成测试 — 真实 MySQL + 真实 loopback A2A HTTP Provider。
 *
 * 定义 startAgentCall 启动既有 AgentCall 的行为契约：
 * 1) 只加载 EXISTING AgentCall + exact AgentCallBinding；endpoint/credential/protocol/contract
 *    都来自 binding，绝不读取最新 AgentRevision/Route。
 * 2) A2A taskId/contextId 经 AgentCallEventIngress 写 AgentCall / AgentSessionBinding；
 *    parent Invocation 与 RuntimeEventIngress 完全不变。
 * 3) 并发同 call+同 input 只 outbound 一次；不同 input 必须冲突。
 * 4) 错误输入/凭据/context 一律 fail closed，零 HTTP，无 parent 变更，错误里不含 secret。
 * 5) 死端点/401/403/503/畸形流 → call failed/lost 分类，父不变，无 runtime session 变更。
 * 6) 网络前失败不得声称成功；outbound claim 后失败经 ingress 产出子域终态/error。
 *
 * 事实源：真实 MySQL（db project，串行）+ 仓内真实 A2A Provider + 真实 fetch。
 * 不 mock transport / store / DB。
 */
import { randomUUID } from "node:crypto";
import { startAgentCall } from "@/lib/agents/calls/application/start-agent-call";
import {
  type ExecutionScenario,
  loadAttempt,
  loadFrozenBinding,
  seedAgentCallExecutionScenario,
  waitForCallTerminal,
} from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  agentCallBindingTable,
  agentCallTable,
  agentSessionBindingTable,
} from "@/lib/persistence/schema/agent-calls";
import { invocationTable, runtimeEventIngressTable } from "@/lib/persistence/schema/executions";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import {
  type ExecutionSubject,
  executionSubjectFromUserIdentity,
} from "@/lib/runtime/transport/execution-subject";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-29T00:00:00.000Z");

/** 已清理的 env 变量名集合（afterEach 删除，避免测试间泄漏 TEST token）。 */
const trackedEnvVars = new Set<string>();

/** 生成 trusted executionSubject（tenant 与 call 一致，满足"verify its tenant equals call tenant"）。 */
function subjectFor(
  scenario: ExecutionScenario,
  overrides?: Partial<ExecutionSubject>,
): ExecutionSubject {
  const subject = executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`);
  return overrides ? { ...subject, ...overrides } : subject;
}

interface ContextEnvironmentShape {
  tenantId: string;
  executionSubject: ExecutionSubject | null;
  now: Date;
  timezone?: string | null;
  locale?: string | null;
}

/** startAgentCall 冻结 API 入参（本测试按规格调用，不含任何 endpoint/auth/agentRevision override）。 */
function startParams(
  scenario: ExecutionScenario,
  opts: {
    input?: string;
    executionSubject?: ExecutionSubject | null;
    timezone?: string;
    contextEnvironment?: ContextEnvironmentShape;
  } = {},
) {
  return {
    tenantId: scenario.tenantId,
    callId: scenario.callId,
    input: opts.input ?? "帮我查一下请假余额",
    contextEnvironment:
      opts.contextEnvironment ??
      ({
        tenantId: scenario.tenantId,
        executionSubject:
          opts.executionSubject === undefined ? subjectFor(scenario) : opts.executionSubject,
        now: NOW,
        timezone: opts.timezone ?? "Asia/Shanghai",
        locale: "zh-CN",
      } satisfies ContextEnvironmentShape),
  };
}

/** 从 start message.metadata 收窄读取 execution_subject 公共主体（unknown → 结构化）。 */
function publicSubjectOf(
  metadata: Record<string, unknown> | undefined,
): { subject_id: unknown; subject_kind: unknown } | undefined {
  const subject = metadata?.execution_subject;
  if (subject && typeof subject === "object" && !Array.isArray(subject)) {
    const s = subject as { subject_id?: unknown; subject_kind?: unknown };
    return { subject_id: s.subject_id, subject_kind: s.subject_kind };
  }
  return undefined;
}

beforeEach(async () => {
  await resetDatabase(db);
  trackedEnvVars.clear();
});

afterEach(async () => {
  for (const key of trackedEnvVars) delete process.env[key];
  trackedEnvVars.clear();
});

describe("startAgentCall 执行域启动", () => {
  it("用 exact binding 完成一次真实 A2A 调用：completed，父不变，无 RuntimeEventIngress 写，Attempt outbound=1/终态", async () => {
    const scenario = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(scenario.credentialEnvVar);

    // 捕获父 Invocation 行（断言 start 全程父不变）。
    const [parentBefore] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, scenario.parentInvocationId))
      .limit(1);

    await startAgentCall(startParams(scenario));

    const terminal = await waitForCallTerminal(scenario.callId, scenario.tenantId);
    expect(terminal.state).toBe("completed");
    const startMsg = scenario.provider.captured.find((c) => !c.resume);
    // A2A taskId/contextId 精确回写：AgentCall 的 refs 必须等于 provider 为该 start 生成的 task/context。
    expect(startMsg?.responseTaskId).toBeTruthy();
    expect(startMsg?.responseContextId).toBeTruthy();
    expect(terminal.externalTaskRef).toBe(startMsg?.responseTaskId as string);
    expect(terminal.externalContextRef).toBe(startMsg?.responseContextId as string);

    // 恰好一次真实 HTTP stream（无重复 outbound）。
    const streamCalls = scenario.provider.rpcMethods.filter((m) => m === "message/stream");
    expect(streamCalls.length).toBe(1);
    expect(scenario.provider.captured.filter((c) => !c.resume).length).toBe(1);
    // Authorization 来自 binding 冻结的 credential（真实 token）。
    const authHeader = scenario.provider.requests.find((r) => r.method === "POST")?.authorization;
    expect(authHeader).toBe(`Bearer ${scenario.credentialToken}`);
    // start message.metadata 只含 execution_subject（provider 合同 required 项），无 tenant/token。
    const publicSubject = publicSubjectOf(startMsg?.messageMetadata);
    expect(publicSubject).toMatchObject({
      subject_id: expect.any(String),
      subject_kind: "platform_user",
    });
    expect(JSON.stringify(startMsg?.messageMetadata)).not.toContain(scenario.credentialToken);
    expect(JSON.stringify(startMsg?.messageMetadata)).not.toContain(scenario.tenantId);

    // 归一化结果非空：resultText / resultJson / resultDigest。
    const [callRow] = await db
      .select()
      .from(agentCallTable)
      .where(eq(agentCallTable.id, scenario.callId))
      .limit(1);
    expect(callRow?.resultText).toBeTruthy();
    expect(callRow?.resultJson).toBeTruthy();
    expect(callRow?.resultDigest).toMatch(/^sha256:/);
    expect(callRow?.errorCode).toBeNull();

    // AgentSessionBinding：exact thread/revision/route/context（A2A contextId）。
    const [session] = await db
      .select()
      .from(agentSessionBindingTable)
      .where(
        and(
          eq(agentSessionBindingTable.tenantId, scenario.tenantId),
          eq(agentSessionBindingTable.externalContextRef, terminal.externalContextRef as string),
        ),
      )
      .limit(1);
    expect(session).toBeTruthy();
    expect(session?.threadId).toBe(scenario.threadId);
    expect(session?.agentRevisionId).toBe(scenario.agentRevisionId);
    expect(session?.deploymentRouteId).toBe(scenario.binding.deploymentRouteId);
    expect(session?.routeRevisionId).toBe(scenario.binding.routeRevisionId);
    expect(session?.bindingState).toBe("active");

    // Attempt outbound=1、终态、task 精确回写。
    const attempt = await loadAttempt(scenario.callId, scenario.tenantId);
    expect(attempt?.dispatchAttemptCount).toBe(1);
    expect(attempt?.attemptState).toBe("completed");

    // 父 Invocation 完全不变（含 refs）。
    const [parentAfter] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, scenario.parentInvocationId))
      .limit(1);
    expect(parentAfter).toEqual(parentBefore);
    expect(parentAfter?.executionState).toBe("running");

    // 无 RuntimeEventIngress 写（AgentCall 事件绝不触碰父 Runtime event ledger）。
    const ingressRows = await db
      .select()
      .from(runtimeEventIngressTable)
      .where(eq(runtimeEventIngressTable.invocationId, scenario.parentInvocationId));
    expect(ingressRows.length).toBe(0);
  });

  it("幂等 claim：同 call 并发 start 只发一次真实 stream/一个 task/一个 attempt，返回已有结果", async () => {
    const scenario = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(scenario.credentialEnvVar);

    // 并发启动同一 call（idempotency 派生自 durable call/attempt 身份，非随机）。
    const [first, second] = await Promise.all([
      startAgentCall(startParams(scenario)),
      startAgentCall(startParams(scenario)),
    ]);
    expect(first.id).toBe(scenario.callId);
    expect(second.id).toBe(scenario.callId);

    // 恰好一条真实 HTTP stream / 一个外部 task。
    expect(scenario.provider.rpcMethods.filter((m) => m === "message/stream").length).toBe(1);
    expect(scenario.provider.captured.filter((c) => !c.resume).length).toBe(1);

    const terminal = await waitForCallTerminal(scenario.callId, scenario.tenantId);
    expect(terminal.state).toBe("completed");

    // 只有一个 attempt（attemptNo=1），outbound 恰好 1 次。
    const attempt = await loadAttempt(scenario.callId, scenario.tenantId);
    expect(attempt?.attemptNo).toBe(1);
    expect(attempt?.dispatchAttemptCount).toBe(1);
    expect(attempt?.attemptState).toBe("completed");
  });

  it("已 claim 后不同 input 再次 start 必须拒绝冲突，不得发送新 input", async () => {
    const scenario = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(scenario.credentialEnvVar);

    await startAgentCall(startParams(scenario, { input: "原始请求" }));
    // 等它 claim 完成（进入 running / 已有外部 task）。
    const terminal = await waitForCallTerminal(scenario.callId, scenario.tenantId);

    // 不同 input 再次 start → 拒绝（冲突或保留原请求），绝不发送新 input。
    await expect(
      startAgentCall(startParams(scenario, { input: "被篡改的请求" })),
    ).rejects.toThrow();
    // 仍只有一个外部 task / 一条真实 stream；没有第二条带新 input 的 HTTP。
    expect(scenario.provider.captured.filter((c) => !c.resume).length).toBe(1);
    expect(scenario.provider.captured[0]?.text).toBe("原始请求");
    expect(terminal.state).toBe("completed");
  });

  it("冻结后新建最新 AgentRevision/credential 不影响 start 的 endpoint/Authorization/contract，binding 行/hash 不变", async () => {
    const scenario = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(scenario.credentialEnvVar);

    // 在 call 冻结之后，新建"最新"published 修订 + 新 CredentialRef。
    const latest = await scenario.createNewLatestEvidence();
    // 新 credential 的 TEST env 也要在 afterEach 删除。
    trackedEnvVars.add(latest.newCredentialEnvVar);

    // 新快照与冻结快照存在可观察内容差异（非仅新 ID）。
    expect(latest.newContextDigest).not.toBe(scenario.agentContextDigest);

    // 冻结后首次 start —— 必须仍用 binding 的旧 endpoint/Authorization/contract。
    await startAgentCall(startParams(scenario));
    const terminal = await waitForCallTerminal(scenario.callId, scenario.tenantId);
    expect(terminal.state).toBe("completed");

    // HTTP endpoint 仍是 binding 冻结的 provider 地址。
    expect(scenario.provider.requests.some((r) => r.path === "/")).toBe(true);
    // Authorization 仍是 binding 冻结的旧 token。
    const authHeader = scenario.provider.requests.find((r) => r.method === "POST")?.authorization;
    expect(authHeader).toBe(`Bearer ${scenario.credentialToken}`);
    // 新 credential 的 token 绝不进入任何 Authorization（不能用 credentialRefId 冒充 token）。
    expect(
      scenario.provider.requests.every(
        (r) => r.authorization !== `Bearer ${latest.newCredentialToken}`,
      ),
    ).toBe(true);
    // contract 元数据来自 binding 冻结 snapshot：outbound 仍发 current_datetime（冻结合同声明），
    // 而绝不含新合同才声明的 timezone —— 若错误使用最新修订合同，此处会反转。
    const startMsg = scenario.provider.captured.find((c) => !c.resume);
    expect(publicSubjectOf(startMsg?.messageMetadata)?.subject_kind).toBe("platform_user");
    expect(startMsg?.messageMetadata?.current_datetime).toBeTruthy();
    expect("timezone" in (startMsg?.messageMetadata ?? {})).toBe(false);

    // binding 行与 hash 完全不变（不可变证据，exact binding）。
    const frozenRow = await loadFrozenBinding(scenario.callId, scenario.tenantId);
    expect(frozenRow?.bindingHash).toBe(scenario.bindingHash);
    expect(frozenRow?.endpointRef).toBe(scenario.endpoint);
    expect(frozenRow?.credentialRefId).toBe(scenario.credentialRefId);
    expect(frozenRow?.agentRevisionId).toBe(scenario.agentRevisionId);
    expect(frozenRow?.agentContextDigest).toBe(scenario.agentContextDigest);
  });

  it("fail closed：错误输入/context 缺失或拒绝在 outbound 前失败，零 HTTP，父不变", async () => {
    // 无效输入（空/空白）——网络前拒绝。
    const emptyInput = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(emptyInput.credentialEnvVar);
    await expect(startAgentCall(startParams(emptyInput, { input: "   " }))).rejects.toThrow();
    expect(emptyInput.provider.requests.length).toBe(0);
    await emptyInput.provider.close();

    // required context 缺失（executionSubject=null）→ 网络前 RequiredContextUnavailableError。
    const missingCtx = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(missingCtx.credentialEnvVar);
    await expect(
      startAgentCall(startParams(missingCtx, { executionSubject: null })),
    ).rejects.toThrow();
    expect(missingCtx.provider.requests.length).toBe(0);
    await missingCtx.provider.close();

    // required context 被 policy 拒绝：合同声明 required 数据型 context（conversation_context），
    // externalAgentContextPolicyFilter 拒绝 → 网络前 RequiredContextDeniedError，no allowAll。
    const deniedCtx = await seedAgentCallExecutionScenario({
      contract: {
        contract_version: "1.0.0",
        agent: { id: "exec-agent", name: { "zh-CN": "执行测试Agent" }, version: "1.0.0" },
        capabilities: [{ key: "general_assistance", name: { "zh-CN": "通用协助" } }],
        invocation_context: [
          { key: "conversation_context", name: { "zh-CN": "会话" }, necessity: "required" },
        ],
        interaction: {
          streaming_transport: true,
          incremental_content: false,
          input_required: false,
          resume: false,
          cancel: false,
          durable_task_recovery: false,
          supported_locales: ["zh-CN", "en"],
        },
        result_contract: { fields: ["status"], error_codes: ["ERR"], notes: { "zh-CN": "无" } },
      },
    });
    trackedEnvVars.add(deniedCtx.credentialEnvVar);
    await expect(
      startAgentCall(
        startParams(deniedCtx, {
          contextEnvironment: {
            tenantId: deniedCtx.tenantId,
            executionSubject: subjectFor(deniedCtx),
            now: NOW,
          },
        }),
      ),
    ).rejects.toThrow();
    expect(deniedCtx.provider.requests.length).toBe(0);
    await deniedCtx.provider.close();

    // 三种失败均不触碰父 Invocation。
    for (const s of [emptyInput, missingCtx, deniedCtx]) {
      const [p] = await db
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, s.parentInvocationId))
        .limit(1);
      expect(p?.executionState).toBe("running");
    }
  });

  it("fail closed：错误凭据/协议/租户/binding 缺失 → 零 HTTP，无 secret 泄漏，无 parent 变更", async () => {
    // 错误租户：用不存在的租户调同一 callId → 查不到 binding，fail。
    const wrongTenant = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(wrongTenant.credentialEnvVar);
    const foreignTenant = randomUUID();
    await expect(
      startAgentCall({
        tenantId: foreignTenant,
        callId: wrongTenant.callId,
        input: "hi",
        contextEnvironment: {
          tenantId: foreignTenant,
          executionSubject: subjectFor(wrongTenant, { tenantId: foreignTenant }),
          now: NOW,
        },
      }),
    ).rejects.toThrow();
    expect(wrongTenant.provider.requests.length).toBe(0);
    await wrongTenant.provider.close();

    // 缺 binding：callId 无冻结 binding → fail。
    const noBinding = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(noBinding.credentialEnvVar);
    await db
      .delete(agentCallBindingTable)
      .where(eq(agentCallBindingTable.callId, noBinding.callId));
    await expect(startAgentCall(startParams(noBinding))).rejects.toThrow();
    expect(noBinding.provider.requests.length).toBe(0);
    await noBinding.provider.close();

    // 不支持协议 → 网络前拒绝。
    const badProtocol = await seedAgentCallExecutionScenario({
      mutateBinding: (b) => ({ ...b, protocolType: "unsupported" }),
    });
    trackedEnvVars.add(badProtocol.credentialEnvVar);
    await expect(startAgentCall(startParams(badProtocol))).rejects.toThrow();
    expect(badProtocol.provider.requests.length).toBe(0);
    await badProtocol.provider.close();

    // 凭据失败参数化：missing/revoked/rotated(fingerprint)/expired。
    const credentialCases: Array<{
      name: string;
      mutate: (p: { id: string; envVar: string; token: string; tenantId: string }) => Promise<void>;
    }> = [
      {
        name: "credential 缺失",
        mutate: async (p) => {
          await db.delete(credentialRefTable).where(eq(credentialRefTable.id, p.id));
        },
      },
      {
        name: "credential revoked",
        mutate: async (p) => {
          await db
            .update(credentialRefTable)
            .set({ lifecycleState: "revoked" })
            .where(eq(credentialRefTable.id, p.id));
        },
      },
      {
        name: "credential 过期",
        mutate: async (p) => {
          await db
            .update(credentialRefTable)
            .set({ expiresAt: new Date("2020-01-01T00:00:00Z") })
            .where(eq(credentialRefTable.id, p.id));
        },
      },
      {
        name: "credential fingerprint 不匹配（rotated）",
        mutate: async (p) => {
          await db
            .update(credentialRefTable)
            .set({ fingerprint: `sha256:${"a".repeat(64)}` })
            .where(eq(credentialRefTable.id, p.id));
        },
      },
    ];
    for (const c of credentialCases) {
      const s = await seedAgentCallExecutionScenario({ mutateCredential: c.mutate });
      trackedEnvVars.add(s.credentialEnvVar);
      const err = await startAgentCall(startParams(s)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(s.provider.requests.length).toBe(0);
      // 错误/ingress 中不得出现 token（secret 红线）。
      expect(JSON.stringify(err)).not.toContain(s.credentialToken);
      // 无 parent 变更。
      const [p] = await db
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, s.parentInvocationId))
        .limit(1);
      expect(p?.executionState).toBe("running");
      await s.provider.close();
    }
  });

  it("网络失败分类：dead/401/403/503/畸形流 → call failed/lost，父 running，无 runtime session 变更", async () => {
    // dead endpoint：binding 冻结到一个无人监听端口 → 连接拒绝，call failed/lost。
    const dead = await seedAgentCallExecutionScenario({
      mutateBinding: (b) => ({ ...b, endpointRef: "http://127.0.0.1:1" }),
    });
    trackedEnvVars.add(dead.credentialEnvVar);
    const deadResult = await startAgentCall(startParams(dead));
    expect(["failed", "lost"]).toContain(deadResult.state);
    expect(deadResult.id).toBe(dead.callId);
    const deadTerminal = await waitForCallTerminal(dead.callId, dead.tenantId);
    expect(["failed", "lost"]).toContain(deadTerminal.state);
    const [deadParent] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, dead.parentInvocationId))
      .limit(1);
    expect(deadParent?.executionState).toBe("running");
    const deadSessions = await db
      .select()
      .from(agentSessionBindingTable)
      .where(eq(agentSessionBindingTable.tenantId, dead.tenantId));
    expect(deadSessions.length).toBe(0);
    await dead.provider.close();

    // 401/403：provider 要求匹配 Bearer，而 binding 用错 token → 认证失败，call failed，无 session。
    const auth = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(auth.credentialEnvVar);
    auth.provider.setExpectedBearerToken(`wrong-${auth.credentialToken}`);
    await startAgentCall(startParams(auth)).catch(() => {});
    const authTerminal = await waitForCallTerminal(auth.callId, auth.tenantId);
    expect(authTerminal.state).toBe("failed");
    const authSessions = await db
      .select()
      .from(agentSessionBindingTable)
      .where(eq(agentSessionBindingTable.tenantId, auth.tenantId));
    expect(authSessions.length).toBe(0);
    await auth.provider.close();

    // 503 transient：第一个 JSON-RPC 请求返回 503 → transient 分类，父不变。
    const flaky = await seedAgentCallExecutionScenario();
    trackedEnvVars.add(flaky.credentialEnvVar);
    flaky.provider.setFlaky(1);
    await startAgentCall(startParams(flaky)).catch(() => {});
    const flakyTerminal = await waitForCallTerminal(flaky.callId, flaky.tenantId);
    expect(["failed", "lost"]).toContain(flakyTerminal.state);
    const [flakyParent] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, flaky.parentInvocationId))
      .limit(1);
    expect(flakyParent?.executionState).toBe("running");
    await flaky.provider.close();

    // 畸形 SSE 流 → protocol parse 失败 → call failed/lost，父不变，无 session。
    const malformed = await seedAgentCallExecutionScenario({ providerScenario: "malformed" });
    trackedEnvVars.add(malformed.credentialEnvVar);
    await startAgentCall(startParams(malformed)).catch(() => {});
    const malformedTerminal = await waitForCallTerminal(malformed.callId, malformed.tenantId);
    expect(["failed", "lost"]).toContain(malformedTerminal.state);
    const [malformedParent] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, malformed.parentInvocationId))
      .limit(1);
    expect(malformedParent?.executionState).toBe("running");
    const malformedSessions = await db
      .select()
      .from(agentSessionBindingTable)
      .where(eq(agentSessionBindingTable.tenantId, malformed.tenantId));
    expect(malformedSessions.length).toBe(0);
    await malformed.provider.close();
  });

  it("网络前失败不得声称成功；outbound claim 后失败经 ingress 产出子域终态/error", async () => {
    // 网络前失败（credential 缺失）：call 保持 queued，Attempt 无 outbound，不得被标记成功。
    const preflight = await seedAgentCallExecutionScenario({
      mutateCredential: async (p) => {
        await db.delete(credentialRefTable).where(eq(credentialRefTable.id, p.id));
      },
    });
    trackedEnvVars.add(preflight.credentialEnvVar);
    await expect(startAgentCall(startParams(preflight))).rejects.toThrow();
    const [queuedCall] = await db
      .select()
      .from(agentCallTable)
      .where(eq(agentCallTable.id, preflight.callId))
      .limit(1);
    // 未 outbound：不声称成功；可留在 queued（显式 rejected 操作）或显式失败，但绝不 completed。
    expect(queuedCall?.state).not.toBe("completed");
    const preAttempt = await loadAttempt(preflight.callId, preflight.tenantId);
    expect(preAttempt?.dispatchAttemptCount).toBe(0);
    await preflight.provider.close();

    // outbound claim 后远端失败（provider 场景 failed）→ 经 ingress 产出子域 failed 终态 + attempt error。
    const remoteFail = await seedAgentCallExecutionScenario({ providerScenario: "failed" });
    trackedEnvVars.add(remoteFail.credentialEnvVar);
    await startAgentCall(startParams(remoteFail)).catch(() => {});
    const failTerminal = await waitForCallTerminal(remoteFail.callId, remoteFail.tenantId);
    expect(failTerminal.state).toBe("failed");
    const failAttempt = await loadAttempt(remoteFail.callId, remoteFail.tenantId);
    expect(failAttempt?.attemptState).toBe("failed");
    expect(failAttempt?.dispatchAttemptCount).toBe(1);
    const [failParent] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, remoteFail.parentInvocationId))
      .limit(1);
    expect(failParent?.executionState).toBe("running");
    await remoteFail.provider.close();
  });
});
