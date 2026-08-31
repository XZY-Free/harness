import { EventSequenceGapError } from "@/lib/conversations/errors";
import { db } from "@/lib/db/client";
import { agentCallEventIngressTable, agentCallTable } from "@/lib/persistence/schema/agent-calls";
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
  const [call] = await db
    .select()
    .from(agentCallTable)
    .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
    .limit(1);
  if (!call || call.state !== "waiting_user") return { coordinated: false };
  if (
    call.sourceType !== "harness_planned" ||
    !call.sourceRef ||
    !call.externalTaskRef ||
    !call.externalContextRef
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
  const [inputEvent] = await db
    .select()
    .from(agentCallEventIngressTable)
    .where(
      and(
        eq(agentCallEventIngressTable.callId, callId),
        eq(agentCallEventIngressTable.tenantId, tenantId),
        eq(agentCallEventIngressTable.candidateType, "call.input_required"),
        eq(agentCallEventIngressTable.ingressState, "mapped"),
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
  const producerEventId = `agent-input-required:${inputEvent.id}`;
  const existing = await getIngressByProducerEventId(tenantId, parent.id, producerEventId);
  if (existing) return { coordinated: true, runtimeProducerEventId: producerEventId };

  const runtimePayload = {
    request_type: "input",
    purpose: "a2a_input_required",
    prompt,
    input_schema: inputSchema,
    agent_call_id: call.id,
    agent_call_event_id: inputEvent.id,
    action_id: call.sourceRef,
    task_id: call.externalTaskRef,
    context_id: call.externalContextRef,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
