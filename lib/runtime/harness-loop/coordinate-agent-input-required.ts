import { createHash, randomUUID } from "node:crypto";
import { loadHostControlCapabilityPolicy } from "@/lib/agents/calls/application/host-control-policy";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  type ConfirmationProposal,
  parseHostControls,
} from "@/lib/agents/calls/transport/a2a/host-control-contract";
import { agentHostControlConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { authorityIdentity } from "@/lib/executions/domain/execution-authority";
import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { agentCallEventIngressTable } from "@/lib/persistence/schema/agent-calls";
import { agentTable } from "@/lib/persistence/schema/agents";
import { invocationTable } from "@/lib/persistence/schema/executions";
import {
  ProducerSequenceGapError,
  getIngressByInvocation,
  getIngressByProducerEventId,
  ingressRuntimeEvents,
} from "@/lib/runtime/application/ingress-runtime-events";
import {
  buildConfirmationActionId,
  computeConfirmationProposalSemanticDigest,
} from "@/lib/runtime/harness-loop/confirmation-proposal-identity";
import { getRuntimeSessionBindingByOwnership } from "@/lib/runtime/persistence/runtime-session-store";
import {
  type RecoverablePauseCheckpointOutcome,
  takeRecoverablePauseCheckpoint,
} from "@/lib/workspace/checkpoint-pause";
import { and, desc, eq } from "drizzle-orm";

export interface CoordinateAgentInputRequiredResult {
  coordinated: boolean;
  runtimeProducerEventId?: string;
  /**
   * R09 §8：CHECKPOINT_RESTORABLE 的 Workspace 在进入可恢复暂停时必须先拿到 Checkpoint。
   * 非 checkpoint 模式返回 `not_checkpoint_restorable`（显式跳过原因，不是静默）。
   */
  checkpoint: RecoverablePauseCheckpointOutcome | null;
}

interface AgentInputRequiredRuntimePayload {
  request_type: "confirmation" | "input";
  purpose: "a2a_confirmation" | "a2a_input_required";
  action_id: string;
  /** Parent Harness action，仅用于服务端关联校验，绝不作为 UAR 幂等键。 */
  harness_action_id: string;
  prompt?: string;
  input_schema?: Record<string, unknown>;
  proposal_id?: string;
  action_key?: string;
  title?: string;
  summary?: string;
  impact?: string;
  preview?: Record<string, unknown>;
  proposal_semantic_digest?: string;
  expires_at?: string;
  agent_call_id: string;
  agent_display_name: string | null;
  agent_call_event_id: string;
  task_id: string;
  context_id: string;
}

/**
 * 由已落库 A2A input-required 事件构造 Parent UAR 载荷。
 *
 * 普通 input 的幂等键按 input event 区分；confirmation 的幂等键按外部业务提议区分。
 * 父 Harness action 另存于 harness_action_id，只用于校验关联。
 */
export function buildAgentInputRequiredRuntimePayload(params: {
  callId: string;
  sourceRef: string;
  externalTaskRef: string;
  externalContextRef: string;
  agentDisplayName: string | null;
  inputEventId: string;
  prompt: string;
  inputSchema: Record<string, unknown>;
  confirmation: ConfirmationProposal | null;
  now: Date;
  confirmationTtlMs?: number;
}): AgentInputRequiredRuntimePayload {
  const common = {
    harness_action_id: params.sourceRef,
    agent_call_id: params.callId,
    agent_display_name: params.agentDisplayName,
    agent_call_event_id: params.inputEventId,
    task_id: params.externalTaskRef,
    context_id: params.externalContextRef,
  };
  if (!params.confirmation) {
    return {
      request_type: "input",
      purpose: "a2a_input_required",
      action_id: episodeActionId("input", params.callId, params.inputEventId),
      prompt: params.prompt,
      input_schema: params.inputSchema,
      ...common,
    };
  }

  const ttlMs = params.confirmationTtlMs ?? agentHostControlConfig.confirmationTtlMs;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("外部 Agent confirmation TTL 必须是正整数");
  }
  return {
    request_type: "confirmation",
    purpose: "a2a_confirmation",
    ...confirmationPrompt(params.confirmation, {
      agentCallId: params.callId,
      taskId: params.externalTaskRef,
      contextId: params.externalContextRef,
    }),
    expires_at: new Date(params.now.getTime() + ttlMs).toISOString(),
    ...common,
  };
}

/**
 * Runtime 侧把已落库的 AgentCall input-required 子事实提升为 Parent 的正式等待点。
 * A2A mapper 仍只写 AgentCall；本应用协调器经 RuntimeEventIngress 原子创建
 * UserActionRequest，并同步 Parent Invocation / Turn → waiting_user。
 */
export async function coordinateAgentInputRequired(
  tenantId: string,
  callId: string,
): Promise<CoordinateAgentInputRequiredResult> {
  const call = await mysqlAgentCallStore.getById({ callId, tenantId });
  if (!call || call.state !== "waiting_user") return { coordinated: false, checkpoint: null };
  if (
    call.sourceType !== "harness_planned" ||
    !call.sourceRef ||
    !call.currentAttempt?.externalTaskRef ||
    !call.sessionBinding?.externalContextRef
  ) {
    throw new Error(`AgentCall ${callId} input-required 缺少 Harness/task/context 关联`);
  }
  const [parent] = await db
    .select()
    .from(invocationTable)
    .where(
      and(eq(invocationTable.id, call.parentInvocationId), eq(invocationTable.tenantId, tenantId)),
    )
    .limit(1);
  if (!parent?.threadId || !parent.turnId) {
    throw new Error(`AgentCall ${callId} 的 Parent 缺少 Thread/Turn`);
  }
  const [agent] = await db
    .select({ displayName: agentTable.displayName })
    .from(agentTable)
    .where(and(eq(agentTable.id, call.agentId), eq(agentTable.tenantId, tenantId)))
    .limit(1);
  const [inputEvent] = await db
    .select()
    .from(agentCallEventIngressTable)
    .where(
      and(
        eq(agentCallEventIngressTable.callId, callId),
        eq(agentCallEventIngressTable.tenantId, tenantId),
        eq(agentCallEventIngressTable.candidateType, "call.input_required"),
        eq(agentCallEventIngressTable.ingressState, "applied"),
      ),
    )
    .orderBy(desc(agentCallEventIngressTable.producerSequence))
    .limit(1);
  if (!inputEvent) throw new Error(`AgentCall ${callId} 缺少已映射 input-required 事件`);

  const payload = asRecord(inputEvent.payloadJson);
  const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
  const inputSchema = asRecord(payload?.input_schema);
  if (!prompt || !inputSchema) {
    throw new Error(`AgentCall ${callId} input-required 缺少 prompt/input_schema`);
  }
  const binding = await mysqlAgentCallStore.getBinding({ callId, tenantId });
  if (!binding) throw new Error(`AgentCall ${callId} 缺少冻结 Binding`);
  const hostControlPolicy = await loadHostControlCapabilityPolicy(
    tenantId,
    binding.agentRevisionId,
  );
  const parsedHostControls = parseHostControls(payload?.data, "input-required", hostControlPolicy);
  const confirmation =
    parsedHostControls?.kind === "confirmation" ? parsedHostControls.proposal : null;
  const producerEventId = randomUUID();
  const existing = await getIngressByProducerEventId(tenantId, parent.id, producerEventId);
  if (existing)
    return { coordinated: true, runtimeProducerEventId: producerEventId, checkpoint: null };
  const owner = await getActiveExecutionOwnership({ tenantId, invocationId: parent.id });
  if (!owner) throw new Error(`Parent Invocation ${parent.id} 缺少 Current ExecutionOwnership`);
  const session = await getRuntimeSessionBindingByOwnership(tenantId, owner.id);
  if (!session) throw new Error(`Parent Invocation ${parent.id} 缺少 RuntimeSessionBinding`);
  const authority = authorityIdentity({
    invocationId: parent.id,
    runtimeRevisionId: session.runtimeRevisionId,
    attemptId: owner.attemptId,
    ownershipId: owner.id,
    leaseEpoch: owner.leaseEpoch,
    sessionBindingId: session.id,
  });

  const runtimePayload = buildAgentInputRequiredRuntimePayload({
    callId: call.id,
    sourceRef: call.sourceRef,
    externalTaskRef: call.currentAttempt.externalTaskRef,
    externalContextRef: call.sessionBinding.externalContextRef,
    agentDisplayName: agent?.displayName ?? null,
    inputEventId: inputEvent.id,
    prompt,
    inputSchema,
    confirmation,
    now: new Date(),
  });
  for (let retry = 0; retry < 3; retry += 1) {
    const ingress = await getIngressByInvocation(tenantId, parent.id, { limit: 500 });
    const sequence =
      ingress.reduce((max, row) => (row.producerSequence > max ? row.producerSequence : max), 0n) +
      1n;
    try {
      await ingressRuntimeEvents({
        tenantId,
        invocationId: parent.id,
        batch: {
          protocolVersion: 3,
          authority,
          events: [
            {
              eventId: producerEventId,
              producerSequence: String(sequence),
              type: "user-action",
              schemaVersion: 1,
              payload: { ...runtimePayload },
            },
          ],
        },
      });
      // §8：暂停事实先落库（它本身是一条正式输入事实，之后必须进锚点），随后立刻
      // 触发安全点流程——「先拿到 Checkpoint 再宣告 paused」在这里体现为：暂停的
      // waiting_user 状态与 Checkpoint 指向同一个已提交水位。
      const checkpoint = await takeRecoverablePauseCheckpoint({
        tenantId,
        invocationId: parent.id,
        requestedById: "agent-input-required",
        requestedByType: "system",
      });
      return { coordinated: true, runtimeProducerEventId: producerEventId, checkpoint };
    } catch (error) {
      const raced = await getIngressByProducerEventId(tenantId, parent.id, producerEventId);
      if (raced)
        return { coordinated: true, runtimeProducerEventId: producerEventId, checkpoint: null };
      if (!(error instanceof ProducerSequenceGapError) || retry === 2) throw error;
    }
  }
  return { coordinated: false, checkpoint: null };
}

function confirmationPrompt(
  proposal: ConfirmationProposal,
  identity: { agentCallId: string; taskId: string; contextId: string },
): Pick<
  AgentInputRequiredRuntimePayload,
  | "action_id"
  | "proposal_id"
  | "action_key"
  | "title"
  | "summary"
  | "impact"
  | "preview"
  | "proposal_semantic_digest"
> {
  return {
    action_id: buildConfirmationActionId({ ...identity, proposalId: proposal.proposal_id }),
    proposal_id: proposal.proposal_id,
    action_key: proposal.action_key,
    title: proposal.title,
    summary: proposal.summary,
    impact: proposal.impact,
    preview: proposal.preview,
    proposal_semantic_digest: computeConfirmationProposalSemanticDigest(proposal),
  };
}

function episodeActionId(kind: "input", callId: string, inputEventId: string): string {
  const digest = createHash("sha256")
    .update(`${callId}\u0000${inputEventId}`)
    .digest("hex")
    .slice(0, 32);
  return `a2a-${kind}:${digest}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
