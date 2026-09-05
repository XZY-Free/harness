import { createHash } from "node:crypto";
import { loadHostControlCapabilityPolicy } from "@/lib/agents/calls/application/host-control-policy";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  type ConfirmationProposal,
  parseHostControls,
} from "@/lib/agents/calls/transport/a2a/host-control-contract";
import { EventSequenceGapError } from "@/lib/conversations/errors";
import { db } from "@/lib/db/client";
import { agentCallEventIngressTable } from "@/lib/persistence/schema/agent-calls";
import { agentTable } from "@/lib/persistence/schema/agents";
import { invocationTable } from "@/lib/persistence/schema/executions";
import {
  getIngressByInvocation,
  getIngressByProducerEventId,
  ingressEventBatch,
} from "@/lib/runtime/event-ingress-queries";
import { and, desc, eq } from "drizzle-orm";

export interface CoordinateAgentInputRequiredResult {
  coordinated: boolean;
  runtimeProducerEventId?: string;
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
  if (!call || call.state !== "waiting_user") return { coordinated: false };
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
  const producerEventId = `agent-input-required:${inputEvent.id}`;
  const existing = await getIngressByProducerEventId(tenantId, parent.id, producerEventId);
  if (existing) return { coordinated: true, runtimeProducerEventId: producerEventId };

  const runtimePayload = {
    request_type: confirmation ? "confirmation" : "input",
    purpose: confirmation ? "a2a_confirmation" : "a2a_input_required",
    ...(confirmation ? confirmationPrompt(confirmation) : { prompt, input_schema: inputSchema }),
    agent_call_id: call.id,
    agent_display_name: agent?.displayName ?? null,
    agent_call_event_id: inputEvent.id,
    action_id: call.sourceRef,
    task_id: call.currentAttempt.externalTaskRef,
    context_id: call.sessionBinding.externalContextRef,
  };
  for (let retry = 0; retry < 3; retry += 1) {
    const ingress = await getIngressByInvocation(tenantId, parent.id, { limit: 500 });
    const sequence = Math.max(0, ...ingress.map((row) => row.producerSequence)) + 1;
    try {
      await ingressEventBatch({
        tenantId,
        invocationId: parent.id,
        producerSequenceStart: sequence,
        events: [
          {
            producer_event_id: producerEventId,
            producer_sequence: sequence,
            type: "user_action.requested",
            schema_version: 1,
            payload: runtimePayload,
          },
        ],
      });
      return { coordinated: true, runtimeProducerEventId: producerEventId };
    } catch (error) {
      const raced = await getIngressByProducerEventId(tenantId, parent.id, producerEventId);
      if (raced) return { coordinated: true, runtimeProducerEventId: producerEventId };
      if (!(error instanceof EventSequenceGapError) || retry === 2) throw error;
    }
  }
  return { coordinated: false };
}

function confirmationPrompt(proposal: ConfirmationProposal): Record<string, unknown> {
  const actionId = `a2a-confirm:${createHash("sha256")
    .update(`${proposal.proposal_id}`)
    .digest("hex")
    .slice(0, 32)}`;
  return {
    action_id: actionId,
    proposal_id: proposal.proposal_id,
    action_key: proposal.action_key,
    title: proposal.title,
    summary: proposal.summary,
    impact: proposal.impact,
    preview: proposal.preview,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
