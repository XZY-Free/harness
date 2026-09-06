import { createHash } from "node:crypto";
import { loadHostControlCapabilityPolicy } from "@/lib/agents/calls/application/host-control-policy";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  type ConfirmationProposal,
  parseHostControls,
} from "@/lib/agents/calls/transport/a2a/host-control-contract";
import { agentHostControlConfig } from "@/lib/config";
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
 * 同一 AgentCall 可以多次等待用户：UAR 的 `(invocationId, harnessActionId)` 需要按
 * input event（确认还带 proposal）区分；父 Harness action 另存于 harness_action_id，
 * 只用于校验关联，不能覆盖 episode 幂等键。
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
    ...confirmationPrompt(params.confirmation, params.callId, params.inputEventId),
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
            payload: { ...runtimePayload },
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

function confirmationPrompt(
  proposal: ConfirmationProposal,
  callId: string,
  inputEventId: string,
): Pick<
  AgentInputRequiredRuntimePayload,
  "action_id" | "proposal_id" | "action_key" | "title" | "summary" | "impact" | "preview"
> {
  return {
    action_id: episodeActionId("confirm", callId, inputEventId, proposal.proposal_id),
    proposal_id: proposal.proposal_id,
    action_key: proposal.action_key,
    title: proposal.title,
    summary: proposal.summary,
    impact: proposal.impact,
    preview: proposal.preview,
  };
}

function episodeActionId(kind: "input" | "confirm", ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  return `a2a-${kind}:${digest}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
