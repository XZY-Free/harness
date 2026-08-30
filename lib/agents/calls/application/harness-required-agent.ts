import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import {
  RequiredAgentUnavailableError,
  type ResolvedRequiredAgentBinding,
  resolveRequiredAgentBinding,
} from "@/lib/agents/calls/application/resolve-agent-call-binding";
import { startAgentCall } from "@/lib/agents/calls/application/start-agent-call";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { db } from "@/lib/db/client";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
/**
 * invokeRequiredAgent — Harness Loop 消费 required Agent capability（专题01 Batch7）。
 *
 * 冻结调用链（00 §八 / 03 §15.2）：
 *   Harness Loop → AgentCall application → resolve agent target → exact AgentCallBinding
 *   → AgentCall → AgentTransport/A2A → Agent Result → Harness Loop。
 *
 * 本服务是「Harness Loop → AgentCall」的确定性编排（第一阶段无通用 Planner）：
 * 1. 解析 Agent Route（target={kind:"agent", agentId}）；unresolved → required 无法满足 → fail closed。
 * 2. 读取 exact AgentContractSnapshot（capabilityDigest + protocol 事实，权威）。
 * 3. 装配 AgentCallBinding candidate，由 createAgentCall 最终事务冻结
 *    （endpoint/identity/credential/network 直接来自 RouteResolution — Batch4 补漏）。
 * 4. createAgentCall（sourceType=user_selected，sourceRef=Turn.id，幂等 logicalCallKey）。
 * 5. startAgentCall（A2A）。
 * 6. 等待 AgentCall 进入终态/waiting_user（轮询 AgentCall store）。
 *
 * 结果归一化：
 * - completed → resultText/resultJson 交给 Harness Loop 做最终整合。
 * - failed → required capability 无法满足 → Harness fail closed（绝不 model-only fallback）。
 * - waiting_user → 返回 call/task/context，由 Harness Loop 转 parent waiting_user，resume 复用 SAME AgentCall。
 *
 * 关键不变量：
 * - AgentCall 是 child fact；AgentCall completed ≠ parent Invocation completed。
 * - A2A taskId → AgentCall.externalTaskRef；contextId → AgentSessionBinding.externalContextRef。
 * - parent ExecutionBinding 保持 runtime-only；Agent evidence 只在 AgentCallBinding。
 */
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { and, eq } from "drizzle-orm";

// RequiredAgentUnavailableError 的冻结语义随共享冻结链移动（Batch8）；re-export 保持
// harness-required-agent 作为 Harness Loop 编排入口的既有类型入口不变。
export { RequiredAgentUnavailableError } from "@/lib/agents/calls/application/resolve-agent-call-binding";

export type HarnessRequiredAgentOutcome =
  | { outcome: "completed"; callId: string; resultText: string; resultJson: unknown }
  | { outcome: "waiting_user"; callId: string; taskId: string; contextId: string }
  | { outcome: "failed"; callId: string; errorCode: string; errorSummary: string };

export interface InvokeRequiredAgentParams {
  tenantId: string;
  parentInvocationId: string;
  threadId: string;
  turnId: string;
  /** capability_requirements 中的 capability_id（= Agent.id）。 */
  agentId: string;
  /** 用户输入文本（A2A start message）。 */
  input: string;
  /** 可信调用主体（06 §6）。 */
  executionSubject: ExecutionSubject | null;
  /** Agent target Route Resolver（唯一 Route Authority）。 */
  resolveRoute: RouteResolver;
  routeScopeKey?: string;
  /** 轮询超时（ms），默认 30s。 */
  pollTimeoutMs?: number;
}

/** 等待 AgentCall 进入终态/waiting_user（轮询 AgentCall store）。 */
async function waitForAgentCallTerminal(
  tenantId: string,
  callId: string,
  timeoutMs: number,
): Promise<"completed" | "failed" | "cancelled" | "lost" | "waiting_user"> {
  const start = Date.now();
  for (;;) {
    const [row] = await db
      .select()
      .from(agentCallTable)
      .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
      .limit(1);
    if (row) {
      const state = String(row.state);
      if (["completed", "failed", "cancelled", "lost"].includes(state)) {
        return state as "completed" | "failed" | "cancelled" | "lost";
      }
      if (state === "waiting_user") return "waiting_user";
    }
    if (Date.now() - start > timeoutMs) {
      throw new RequiredAgentUnavailableError(callId, `AgentCall 未在 ${timeoutMs}ms 内到达终态`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 读取冻结后的 AgentCall 结果（completed 用）。 */
async function readCallResult(
  tenantId: string,
  callId: string,
): Promise<{ resultText: string; resultJson: unknown }> {
  const [row] = await db
    .select({ resultText: agentCallTable.resultText, resultJson: agentCallTable.resultJson })
    .from(agentCallTable)
    .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
    .limit(1);
  return {
    resultText: typeof row?.resultText === "string" ? row.resultText : "",
    resultJson: row?.resultJson,
  };
}

/** 读取等待用户补充时的 task/context refs（resume 用）。 */
async function readWaitingRefs(
  tenantId: string,
  callId: string,
): Promise<{ taskId: string; contextId: string }> {
  const [row] = await db
    .select({
      externalTaskRef: agentCallTable.externalTaskRef,
      externalContextRef: agentCallTable.externalContextRef,
    })
    .from(agentCallTable)
    .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
    .limit(1);
  if (!row?.externalTaskRef || !row?.externalContextRef) {
    throw new RequiredAgentUnavailableError(
      callId,
      "AgentCall waiting_user 缺少 task/context refs",
    );
  }
  return { taskId: row.externalTaskRef, contextId: row.externalContextRef };
}

const createAgentCall = createCreateAgentCall({ store: mysqlAgentCallStore });

/**
 * 解析 required Agent 路由并冻结 binding，创建并启动 AgentCall，等待结果。
 * 返回归一化结果（completed / waiting_user / failed）。
 */
export async function invokeRequiredAgent(
  params: InvokeRequiredAgentParams,
): Promise<HarnessRequiredAgentOutcome> {
  const now = new Date();
  const { tenantId, parentInvocationId, threadId, turnId, agentId, input } = params;

  // 1-3. 解析 Agent Route（唯一 Route Authority）+ 读取 exact ContractSnapshot +
  //       装配 AgentCallBinding candidate — 共享解析链（Batch8 提取）。
  const resolved: ResolvedRequiredAgentBinding = await resolveRequiredAgentBinding({
    tenantId,
    agentId,
    resolveRoute: params.resolveRoute,
    routeScopeKey: params.routeScopeKey ?? "default",
    businessKey: { threadId },
  });
  const binding = resolved.bindingCandidate;

  // 4. createAgentCall（幂等 logicalCallKey：required-agent:<turnId>:<agentId>）。
  const logicalCallKey = `required-agent:${turnId}:${agentId}`;
  const { call } = await createAgentCall({
    tenantId,
    parentInvocationId,
    agentId,
    agentRevisionId: resolved.agentRevisionId,
    sourceType: "user_selected",
    sourceRef: turnId,
    logicalCallKey,
    bindingCandidate: binding,
    now,
  });
  const callId = call.id;

  // 5. startAgentCall（A2A）— detached 流经 AgentCallEventIngress 持久化终态。
  await startAgentCall({
    tenantId,
    callId,
    input,
    contextEnvironment: {
      tenantId,
      executionSubject: params.executionSubject,
      now,
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    },
  });

  // 6. 等待 AgentCall 进入终态/waiting_user。
  const terminal = await waitForAgentCallTerminal(tenantId, callId, params.pollTimeoutMs ?? 30_000);
  if (terminal === "completed") {
    const result = await readCallResult(tenantId, callId);
    return {
      outcome: "completed",
      callId,
      resultText: result.resultText,
      resultJson: result.resultJson,
    };
  }
  if (terminal === "waiting_user") {
    const refs = await readWaitingRefs(tenantId, callId);
    return { outcome: "waiting_user", callId, taskId: refs.taskId, contextId: refs.contextId };
  }
  // failed / cancelled / lost → required capability 无法满足 → fail closed。
  const [row] = await db
    .select({ errorCode: agentCallTable.errorCode, errorSummary: agentCallTable.errorSummary })
    .from(agentCallTable)
    .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
    .limit(1);
  return {
    outcome: "failed",
    callId,
    errorCode: row?.errorCode ?? `AGENT_CALL_${terminal.toUpperCase()}`,
    errorSummary: row?.errorSummary ?? `required Agent 调用 ${terminal}`,
  };
}
