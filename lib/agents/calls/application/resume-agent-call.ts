/**
 * resumeAgentCall — 恢复既有 AgentCall 子执行。
 *
 * 冻结边界：
 * - 只 tenant-scoped 加载 existing AgentCall + exact AgentCallBinding；endpoint /
 *   credential / protocol / contract 全部来自 binding，绝不读取最新 AgentRevision/
 *   Route/Contract/Credential。
 * - 复用 SAME AgentCall / SAME exact AgentRevision / SAME binding / SAME external
 *   contextId（A2A message/send）；不新建顶层 Invocation，不重新解析成别的 AgentRevision。
 * - 状态：waiting_user → running。非 waiting_user 按幂等语义返回既有 call 或抛错。
 * - resume 事件重定位起始 producerSequence 禁止回退（durable max+1）。
 * - A2A taskId/contextId 只经 AgentCallEventIngress 写 Attempt / AgentSessionBinding；
 *   绝不触碰 parent Invocation / RuntimeSessionBinding / RuntimeEventIngress。
 *
 * 事实源：
 * - docs/architecture/agent-control-plane.md
 * - docs/architecture/api-and-events.md
 * - 冻结架构：AgentCall 是 child fact，resume 属于 AgentCall 子域 Authority。
 */
import { agentCallStore } from "@/lib/agents/calls/application/agent-call-events-common";
import {
  nextAgentCallProducerSequence,
  synthesizeAgentCallTerminalEvent,
} from "@/lib/agents/calls/application/agent-call-events-common";
import { transitionAgentCall } from "@/lib/agents/calls/application/agent-call-transition";
import { loadHostControlCapabilityPolicy } from "@/lib/agents/calls/application/host-control-policy";
import { ingestAgentCallEvents } from "@/lib/agents/calls/application/ingest-agent-call-events";
import type { AgentCall } from "@/lib/agents/calls/domain/agent-call";
import {
  buildAgentCallContextMetadata,
  createAgentCallTransport,
  loadAgentCallContract,
  resolveAgentCallOutboundAuth,
} from "@/lib/agents/calls/transport/agent-call-transport-factory";
import {
  type AgentBackgroundFailureHandler,
  type AgentCallEventSink,
  AgentTransportError,
} from "@/lib/agents/calls/transport/agent-transport";
import type { PlatformContextEnvironment } from "@/lib/context/enrichment/build-invocation-context-bundle";
import {
  loadCurrentEnterpriseUserProfile,
  loadEnterpriseUserAccessPolicy,
} from "@/lib/identity/enterprise-user-access-policy";

/** resumeAgentCall 冻结 API 入参。 */
export interface ResumeAgentCallCommand {
  tenantId: string;
  callId: string;
  /** 用户补充文本（非空纯文本；空白/缺失网络前失败）。 */
  text?: string;
  /** confirmation UAR 的结构化解析事实。 */
  confirmation?: {
    proposalId: string;
    resolution: "approve" | "deny";
    resolvedAt: string;
  };
  /** 平台上下文（tenant 必须等于 call tenant）。 */
  contextEnvironment?: PlatformContextEnvironment;
}

/** resume 失败类别（路由据此映射稳定错误响应）。 */
export class AgentCallResumeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "call_not_found"
      | "binding_not_found"
      | "state_invalid"
      | "context_missing"
      | "context_tenant_mismatch"
      | "enterprise_context_disabled"
      | "input_invalid"
      | "transport",
  ) {
    super(message);
    this.name = "AgentCallResumeError";
  }
}

/**
 * 恢复既有 AgentCall（waiting_user → running，A2A message/send，same task/context）。
 *
 * 幂等：
 * - call 已 running / 终态 → 返回既有 call（不重复 outbound）。
 * - call 非 waiting_user 且非终态 → 抛 state_invalid。
 */
export async function resumeAgentCall(command: ResumeAgentCallCommand): Promise<AgentCall> {
  const { tenantId, callId } = command;

  // 1. tenant-scoped 加载 existing call + exact binding。
  const call = await agentCallStore.getById({ callId, tenantId });
  if (!call) throw new AgentCallResumeError("AgentCall 不存在", "call_not_found");
  const binding = await agentCallStore.getBinding({ callId, tenantId });
  if (!binding) throw new AgentCallResumeError("AgentCallBinding 不存在", "binding_not_found");

  // 2. 状态校验：只允许 waiting_user → running。
  if (call.state === "running" || isTerminal(call.state)) {
    // 幂等：已恢复/已终态，返回既有 call，不重复 outbound。
    return call;
  }
  if (call.state !== "waiting_user") {
    throw new AgentCallResumeError(
      `AgentCall 当前状态 ${call.state} 不可 resume（期望 waiting_user）`,
      "state_invalid",
    );
  }

  // 3. resume 必须复用 existing task/context（同 AgentCall）。
  const taskId = call.currentAttempt?.externalTaskRef;
  const contextId = call.sessionBinding?.externalContextRef;
  if (!taskId || !contextId) {
    throw new AgentCallResumeError(
      "AgentCall waiting_user 缺少 externalTaskRef/externalContextRef",
      "context_missing",
    );
  }

  // 4. 普通输入与 confirmation 二选一；confirmation 不转成“确认”文本。
  const hasText = typeof command.text === "string" && command.text.trim().length > 0;
  const hasConfirmation = Boolean(command.confirmation);
  if (hasText === hasConfirmation) {
    throw new AgentCallResumeError("resume text 不能为空", "input_invalid");
  }

  // 5. context environment：trusted tenant 必须等于 call tenant。
  const env = command.contextEnvironment;
  if (env && env.tenantId !== tenantId) {
    throw new AgentCallResumeError(
      "contextEnvironment.tenant 与 call tenant 不一致",
      "context_tenant_mismatch",
    );
  }
  if (env?.executionSubject && env.executionSubject.tenantId !== tenantId) {
    throw new AgentCallResumeError(
      "executionSubject.tenant 与 call tenant 不一致",
      "context_tenant_mismatch",
    );
  }

  // 6. 只按 binding 冻结加载 contract + 解析出站凭证。
  const { contract, capabilities } = await loadAgentCallContract(tenantId, callId, {
    agentContractSnapshotId: binding.agentContractSnapshotId,
    agentContractDigest: binding.agentContractDigest,
    agentCapabilityDigest: binding.agentCapabilityDigest,
    agentContextDigest: binding.agentContextDigest,
  });
  const enterprisePolicy = await loadEnterpriseUserAccessPolicy(tenantId, binding.agentRevisionId);
  const hostControlPolicy = await loadHostControlCapabilityPolicy(
    tenantId,
    binding.agentRevisionId,
  );
  if (enterprisePolicy.profileRequirement !== "none") {
    if (!env?.executionSubject || env.executionSubject.subjectType !== "user") {
      throw new AgentCallResumeError("resume 缺少可信用户主体", "context_missing");
    }
    const currentProfile = await loadCurrentEnterpriseUserProfile(
      tenantId,
      env.executionSubject.subjectId,
    );
    if (currentProfile.profileStatus === "disabled") {
      throw new AgentCallResumeError(
        "企业用户已停用，禁止恢复原 AgentCall",
        "enterprise_context_disabled",
      );
    }
    if (!env) throw new AgentCallResumeError("resume 缺少平台上下文", "context_missing");
  }
  const auth = await resolveAgentCallOutboundAuth(tenantId, binding);

  // 7. 构造 transport（事件只走 AgentCallEventIngress；background 只合成子域 lost）。
  let responseAccepted = false;
  const bufferedEvents: Parameters<AgentCallEventSink>[0][] = [];
  const eventSink: AgentCallEventSink = async (batch) => {
    if (!responseAccepted) {
      bufferedEvents.push(batch);
      return;
    }
    await ingestAgentCallEvents({ tenantId, callId, events: batch.events });
  };
  const onBackgroundFailure: AgentBackgroundFailureHandler = async (report) => {
    // 绝不 mark parent lost；只合成 AgentCall 子域 call.lost，sequence 取 durable max+1。
    await synthesizeAgentCallTerminalEvent(
      callId,
      tenantId,
      "call.lost",
      `AGENT_STREAM_${report.failureKind.toUpperCase()}`,
      report.safeSummary,
    );
  };
  const transport = createAgentCallTransport({
    callId,
    tenantId,
    eventSink,
    onBackgroundFailure,
    capabilities,
    streamTimeoutMs: 60_000,
    hostControlPolicy,
  });

  // 8. resumeCall（message/send，same task/context）；producerSequence 取 durable max+1。
  const nextProducerSequence = await nextAgentCallProducerSequence(callId, tenantId);
  const contextMetadata = env
    ? buildAgentCallContextMetadata(
        contract,
        { ...env, enterpriseUserContext: binding.enterpriseUserContext ?? null },
        enterprisePolicy,
      )
    : undefined;
  try {
    await transport.resumeCall({
      callId,
      endpoint: binding.endpointRef,
      auth,
      taskId,
      contextId,
      ...(hasText ? { text: command.text } : { confirmation: command.confirmation }),
      contextMetadata,
      nextProducerSequence,
      idempotencyKey: `agentcall:${callId}:resume:${nextProducerSequence}`,
    });
  } catch (err) {
    if (err instanceof AgentTransportError) {
      throw new AgentCallResumeError(err.message, "transport");
    }
    throw err;
  }

  // 9. 只有远端接受用户回答后，正式命令才可 waiting_user → running。
  const transition = await transitionAgentCall({
    tenantId,
    callId,
    input: "user_response_accepted",
    authority: "user_response",
  });
  if (transition.outcome === "rejected") {
    throw new AgentCallResumeError(
      `AgentCall resume 转换被拒绝：${transition.reasonCode ?? "unknown"}`,
      "state_invalid",
    );
  }
  responseAccepted = true;
  for (const batch of bufferedEvents) {
    await ingestAgentCallEvents({ tenantId, callId, events: batch.events });
  }

  // 10. 远端后续事件继续逐条进入 AgentCallEventIngress。
  const updated = await agentCallStore.getById({ callId, tenantId });
  if (!updated) throw new AgentCallResumeError("AgentCall 读取失败", "call_not_found");
  return updated;
}

function isTerminal(state: string): boolean {
  return ["completed", "failed", "cancelled", "lost"].includes(state);
}
