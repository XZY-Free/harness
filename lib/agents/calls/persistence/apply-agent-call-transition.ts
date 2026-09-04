import { createHash, randomUUID } from "node:crypto";
import type { AgentCallState } from "@/lib/agents/calls/domain/agent-call";
import { isAgentCallAttemptTerminal } from "@/lib/agents/calls/domain/agent-call-attempt";
import {
  type AgentCallContinuationKind,
  type AgentCallTransitionInput,
  decideAgentCallTransition,
} from "@/lib/agents/calls/domain/agent-call-transition";
import type { AgentCallCandidateEvent } from "@/lib/agents/calls/transport/agent-transport";
import { controlPlaneEventDelivery } from "@/lib/control-plane/events/control-plane-event-delivery";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { resolveOutboxAppend } from "@/lib/control-plane/events/outbox-append";
import type { DbOrTx } from "@/lib/db/client";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallEventIngressTable,
  agentCallTable,
  agentSessionBindingTable,
} from "@/lib/persistence/schema/agent-calls";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { and, eq } from "drizzle-orm";

export type AgentCallTransitionAuthority =
  | "agent_event"
  | "local_cancel"
  | "local_failure"
  | "user_response";

export interface ApplyAgentCallTransitionCommand {
  tenantId: string;
  callId: string;
  input: AgentCallTransitionInput;
  authority: AgentCallTransitionAuthority;
  event?: AgentCallCandidateEvent;
  errorCode?: string;
  errorSummary?: string;
  now?: Date;
}

export type AgentCallIngressOutcome = "applied" | "idempotent" | "rejected" | "failed_retryable";

export interface AgentCallTransitionResult {
  outcome: AgentCallIngressOutcome;
  reasonCode?: string;
  beforeVersionNo: number;
  afterVersionNo: number;
  finalState: AgentCallState;
  continuationKind?: AgentCallContinuationKind;
}

type CallRow = typeof agentCallTable.$inferSelect;
type AttemptRow = typeof agentCallAttemptTable.$inferSelect;
type BindingRow = typeof agentCallBindingTable.$inferSelect;

interface LockedAuthority {
  call: CallRow;
  binding: BindingRow;
  parentThreadId: string | null;
  attempts: AttemptRow[];
  session: typeof agentSessionBindingTable.$inferSelect | null;
  producerSource: string;
}

interface EventRefs {
  taskId?: string;
  contextId?: string;
}

interface MappingResult {
  outcome: "ok" | "idempotent" | "rejected";
  reasonCode?: string;
  attempt?: AttemptRow;
  sessionBindingId?: string | null;
  changed?: boolean;
}

export async function applyAgentCallTransition(
  tx: DbOrTx,
  command: ApplyAgentCallTransitionCommand,
): Promise<AgentCallTransitionResult> {
  const now = command.now ?? new Date();
  const authority = await lockAuthority(tx, command.callId, command.tenantId);
  const beforeVersionNo = authority.call.versionNo;

  if (!authorityMatchesInput(command)) {
    return finish(tx, command, authority, now, {
      outcome: "rejected",
      reasonCode: "transition_authority_invalid",
      beforeVersionNo,
      afterVersionNo: beforeVersionNo,
      finalState: authority.call.state as AgentCallState,
    });
  }

  if (command.event) {
    const duplicate = await findDuplicateIngress(tx, authority, command.event);
    if (duplicate) return duplicate;
  }

  const eventValidation = validateEvent(command);
  if (eventValidation) {
    return finish(tx, command, authority, now, {
      outcome: "rejected",
      reasonCode: eventValidation,
      beforeVersionNo,
      afterVersionNo: beforeVersionNo,
      finalState: authority.call.state as AgentCallState,
    });
  }

  // 远端尚未正式 started，或流在运行中丢失时，只结束当前 Attempt；不得伪造
  // queued→failed / running→lost。Durable continuation Worker 会据此创建新 Attempt。
  if (
    command.authority === "local_failure" &&
    (authority.call.state === "queued" || command.input === "call.lost")
  ) {
    const mapping = await resolveMapping(tx, authority, command, now);
    if (mapping.outcome !== "ok" || !mapping.attempt) {
      return finish(tx, command, authority, now, {
        outcome: mapping.outcome === "ok" ? "rejected" : mapping.outcome,
        reasonCode: mapping.reasonCode ?? "active_attempt_missing",
        beforeVersionNo,
        afterVersionNo: beforeVersionNo,
        finalState: authority.call.state as AgentCallState,
      });
    }
    await updateAttemptForTransition(tx, mapping.attempt, command.input, now);
    return finish(tx, command, authority, now, {
      outcome: "applied",
      reasonCode: "attempt_failure_recorded",
      beforeVersionNo,
      afterVersionNo: beforeVersionNo,
      finalState: authority.call.state as AgentCallState,
    });
  }

  const decision = decideAgentCallTransition({
    state: authority.call.state as AgentCallState,
    input: command.input,
  });
  if (decision.outcome === "rejected") {
    return finish(tx, command, authority, now, {
      outcome: "rejected",
      reasonCode: decision.reasonCode,
      beforeVersionNo,
      afterVersionNo: beforeVersionNo,
      finalState: authority.call.state as AgentCallState,
    });
  }
  if (decision.outcome === "idempotent" && isTerminalState(authority.call.state)) {
    return finish(tx, command, authority, now, {
      outcome: "idempotent",
      beforeVersionNo,
      afterVersionNo: beforeVersionNo,
      finalState: authority.call.state as AgentCallState,
    });
  }

  const mapping = await resolveMapping(tx, authority, command, now);
  if (mapping.outcome !== "ok") {
    return finish(tx, command, authority, now, {
      outcome: mapping.outcome,
      reasonCode: mapping.reasonCode,
      beforeVersionNo,
      afterVersionNo: beforeVersionNo,
      finalState: authority.call.state as AgentCallState,
    });
  }
  if (decision.outcome === "idempotent") {
    if (mapping.changed && mapping.sessionBindingId !== authority.call.agentSessionBindingId) {
      await tx
        .update(agentCallTable)
        .set({ agentSessionBindingId: mapping.sessionBindingId })
        .where(
          and(
            eq(agentCallTable.id, command.callId),
            eq(agentCallTable.tenantId, command.tenantId),
            eq(agentCallTable.versionNo, beforeVersionNo),
          ),
        );
    }
    return finish(tx, command, authority, now, {
      outcome: mapping.changed ? "applied" : "idempotent",
      beforeVersionNo,
      afterVersionNo: beforeVersionNo,
      finalState: authority.call.state as AgentCallState,
    });
  }

  const afterVersionNo = beforeVersionNo + 1;
  const updates = buildCallUpdates(
    authority.call,
    command,
    decision.targetState,
    afterVersionNo,
    now,
    mapping.sessionBindingId,
  );
  const updateResult = await tx
    .update(agentCallTable)
    .set(updates)
    .where(
      and(
        eq(agentCallTable.id, command.callId),
        eq(agentCallTable.tenantId, command.tenantId),
        eq(agentCallTable.state, authority.call.state),
        eq(agentCallTable.versionNo, beforeVersionNo),
      ),
    );
  if (updateResult[0].affectedRows !== 1) {
    throw new Error("AgentCall 状态 CAS 冲突，事件必须由可靠接入重试");
  }

  if (mapping.attempt) {
    await updateAttemptForTransition(tx, mapping.attempt, command.input, now);
  }
  if (decision.continuationKind) {
    await appendContinuation(
      tx,
      authority.call,
      command.tenantId,
      afterVersionNo,
      decision.continuationKind,
      now,
    );
  }
  return finish(tx, command, authority, now, {
    outcome: "applied",
    beforeVersionNo,
    afterVersionNo,
    finalState: decision.targetState,
    continuationKind: decision.continuationKind,
  });
}

function authorityMatchesInput(command: ApplyAgentCallTransitionCommand): boolean {
  if (command.authority === "agent_event") return command.event?.type === command.input;
  if (command.authority === "local_cancel") {
    return command.input === "call.cancelled" && command.event === undefined;
  }
  if (command.authority === "local_failure") {
    return (
      (command.input === "call.failed" || command.input === "call.lost") &&
      command.event === undefined &&
      !!command.errorCode
    );
  }
  return command.input === "user_response_accepted" && command.event === undefined;
}

async function lockAuthority(
  tx: DbOrTx,
  callId: string,
  tenantId: string,
): Promise<LockedAuthority> {
  const [call] = await tx
    .select()
    .from(agentCallTable)
    .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
    .limit(1)
    .for("update");
  if (!call) throw new Error(`AgentCall ${callId} 不存在或不属于租户`);
  const [binding] = await tx
    .select()
    .from(agentCallBindingTable)
    .where(
      and(eq(agentCallBindingTable.callId, callId), eq(agentCallBindingTable.tenantId, tenantId)),
    )
    .limit(1)
    .for("update");
  if (!binding) throw new Error(`AgentCallBinding ${callId} 不存在`);
  const attempts = await tx
    .select()
    .from(agentCallAttemptTable)
    .where(
      and(eq(agentCallAttemptTable.callId, callId), eq(agentCallAttemptTable.tenantId, tenantId)),
    )
    .for("update");
  const [parent] = await tx
    .select({ threadId: invocationTable.threadId })
    .from(invocationTable)
    .where(
      and(eq(invocationTable.id, call.parentInvocationId), eq(invocationTable.tenantId, tenantId)),
    )
    .limit(1)
    .for("update");
  if (!parent) throw new Error(`AgentCall parent Invocation ${call.parentInvocationId} 不存在`);
  let session: typeof agentSessionBindingTable.$inferSelect | null = null;
  if (call.agentSessionBindingId) {
    const sessionRows = await tx
      .select()
      .from(agentSessionBindingTable)
      .where(
        and(
          eq(agentSessionBindingTable.id, call.agentSessionBindingId),
          eq(agentSessionBindingTable.tenantId, tenantId),
        ),
      )
      .limit(1)
      .for("update");
    session = sessionRows[0] ?? null;
    if (!session) throw new Error(`AgentSessionBinding ${call.agentSessionBindingId} 不存在`);
  }
  return {
    call,
    binding,
    parentThreadId: parent.threadId,
    attempts,
    session,
    producerSource: `${call.agentId}:${binding.protocolType}:${binding.protocolContractRevision}`,
  };
}

function validateEvent(command: ApplyAgentCallTransitionCommand): string | undefined {
  const event = command.event;
  if (!event) return undefined;
  if (!event.producer_event_id?.trim()) return "producer_event_id_invalid";
  if (!Number.isInteger(event.producer_sequence) || event.producer_sequence < 1) {
    return "producer_sequence_invalid";
  }
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return "payload_invalid";
  }
  const refs = readRefs(event);
  if (event.type === "call.started" && (!refs.taskId || !refs.contextId)) {
    return "started_refs_incomplete";
  }
  if (event.type === "call.completed") {
    const text = typeof event.payload.text === "string" ? event.payload.text : null;
    if (text === null && event.payload.data == null) return "completed_result_invalid";
  }
  if (event.type === "call.failed") {
    const error = event.payload.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return "failed_error_invalid";
    if (typeof (error as Record<string, unknown>).code !== "string") return "failed_error_invalid";
  }
  return undefined;
}

function readRefs(event: AgentCallCandidateEvent): EventRefs {
  const taskId =
    typeof event.payload.task_id === "string" && event.payload.task_id.trim()
      ? event.payload.task_id.trim()
      : undefined;
  const contextId =
    typeof event.payload.context_id === "string" && event.payload.context_id.trim()
      ? event.payload.context_id.trim()
      : undefined;
  return { taskId, contextId };
}

async function resolveMapping(
  tx: DbOrTx,
  authority: LockedAuthority,
  command: ApplyAgentCallTransitionCommand,
  now: Date,
): Promise<MappingResult> {
  const active = authority.attempts.filter(
    (attempt) => !isAgentCallAttemptTerminal(attempt.attemptState),
  );
  if (active.length !== 1) {
    return {
      outcome: "rejected",
      reasonCode: active.length === 0 ? "active_attempt_missing" : "active_attempt_ambiguous",
    };
  }
  const currentAttempt = active[0] as AttemptRow;
  if (!command.event) {
    if (
      command.authority === "user_response" &&
      (!currentAttempt.externalTaskRef || !authority.session)
    ) {
      return { outcome: "rejected", reasonCode: "resume_mapping_incomplete" };
    }
    return {
      outcome: "ok",
      attempt: currentAttempt,
      sessionBindingId: authority.call.agentSessionBindingId,
    };
  }

  const refs = readRefs(command.event);
  if (command.input === "call.started") {
    if (!refs.taskId || !refs.contextId) {
      return { outcome: "rejected", reasonCode: "started_refs_incomplete" };
    }
    if (currentAttempt.externalTaskRef && currentAttempt.externalTaskRef !== refs.taskId) {
      return { outcome: "rejected", reasonCode: "task_mapping_conflict" };
    }
    const mappingChanged =
      currentAttempt.externalTaskRef === null || authority.call.agentSessionBindingId === null;
    const session = await ensureSession(tx, authority, command.tenantId, refs.contextId, now);
    if (session.outcome === "rejected") return session;
    if (!currentAttempt.externalTaskRef) {
      await tx
        .update(agentCallAttemptTable)
        .set({ externalTaskRef: refs.taskId, updatedAt: now })
        .where(eq(agentCallAttemptTable.id, currentAttempt.id));
      currentAttempt.externalTaskRef = refs.taskId;
    }
    return {
      outcome: "ok",
      attempt: currentAttempt,
      sessionBindingId: session.sessionBindingId,
      changed: mappingChanged,
    };
  }

  let attempt: AttemptRow | undefined;
  if (refs.taskId) {
    attempt = authority.attempts.find((candidate) => candidate.externalTaskRef === refs.taskId);
    if (!attempt) return { outcome: "rejected", reasonCode: "task_mapping_not_found" };
  } else {
    if (!refs.contextId) return { outcome: "rejected", reasonCode: "attempt_mapping_incomplete" };
    attempt = currentAttempt;
  }
  if (!attempt) return { outcome: "rejected", reasonCode: "attempt_mapping_incomplete" };
  if (attempt.id !== currentAttempt.id) {
    const target = terminalStateFor(command.input);
    if (target && attempt.attemptState === target) {
      return { outcome: "idempotent", reasonCode: "late_attempt_event" };
    }
    return { outcome: "rejected", reasonCode: "late_attempt_conflict" };
  }
  if (!attempt.externalTaskRef) return { outcome: "rejected", reasonCode: "attempt_task_unbound" };
  if (!authority.session) return { outcome: "rejected", reasonCode: "session_mapping_missing" };
  if (refs.contextId && authority.session.externalContextRef !== refs.contextId) {
    return { outcome: "rejected", reasonCode: "context_mapping_conflict" };
  }
  return { outcome: "ok", attempt, sessionBindingId: authority.session.id };
}

async function ensureSession(
  tx: DbOrTx,
  authority: LockedAuthority,
  tenantId: string,
  contextId: string,
  now: Date,
): Promise<MappingResult> {
  if (authority.session) {
    if (authority.session.externalContextRef !== contextId) {
      return { outcome: "rejected", reasonCode: "context_mapping_conflict" };
    }
    return { outcome: "ok", sessionBindingId: authority.session.id };
  }
  const [existing] = await tx
    .select()
    .from(agentSessionBindingTable)
    .where(
      and(
        eq(agentSessionBindingTable.tenantId, tenantId),
        eq(agentSessionBindingTable.externalContextRef, contextId),
      ),
    )
    .limit(1)
    .for("update");
  if (existing) {
    if (
      existing.threadId !== authority.parentThreadId ||
      existing.agentId !== authority.call.agentId ||
      existing.agentRevisionId !== authority.binding.agentRevisionId ||
      existing.deploymentRouteId !== authority.binding.deploymentRouteId ||
      existing.routeRevisionId !== authority.binding.routeRevisionId ||
      existing.bindingState !== "active"
    ) {
      return { outcome: "rejected", reasonCode: "context_mapping_conflict" };
    }
    return { outcome: "ok", sessionBindingId: existing.id };
  }
  const sessionBindingId = randomUUID();
  await tx.insert(agentSessionBindingTable).values({
    id: sessionBindingId,
    tenantId,
    threadId: authority.parentThreadId,
    agentId: authority.call.agentId,
    agentRevisionId: authority.binding.agentRevisionId,
    deploymentRouteId: authority.binding.deploymentRouteId,
    routeRevisionId: authority.binding.routeRevisionId,
    externalContextRef: contextId,
    bindingState: "active",
    createdAt: now,
    lastUsedAt: now,
  });
  return { outcome: "ok", sessionBindingId };
}

function buildCallUpdates(
  call: CallRow,
  command: ApplyAgentCallTransitionCommand,
  targetState: AgentCallState,
  versionNo: number,
  now: Date,
  sessionBindingId?: string | null,
): Partial<CallRow> {
  const updates: Partial<CallRow> = { state: targetState, versionNo };
  if (targetState === "running" && !call.startedAt) updates.startedAt = now;
  if (targetState === "waiting_user") updates.waitingAt = now;
  if (isTerminalState(targetState)) updates.finishedAt = now;
  if (sessionBindingId !== undefined && sessionBindingId !== call.agentSessionBindingId) {
    updates.agentSessionBindingId = sessionBindingId;
  }
  if (command.event?.type === "call.completed") {
    const text = typeof command.event.payload.text === "string" ? command.event.payload.text : null;
    const data = command.event.payload.data ?? null;
    updates.resultText = text;
    updates.resultJson = data;
    updates.resultDigest = canonicalHash("result", { text, data });
  }
  if (command.event?.type === "call.failed" || command.event?.type === "call.cancelled") {
    const error = command.event.payload.error;
    const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    updates.errorCode =
      typeof detail.code === "string" ? detail.code : command.event.type.toUpperCase();
    updates.errorSummary = typeof detail.message === "string" ? detail.message : null;
  } else if (command.authority === "local_failure") {
    updates.errorCode = command.errorCode ?? "AGENT_CALL_LOCAL_FAILURE";
    updates.errorSummary = command.errorSummary ?? null;
  }
  return updates;
}

async function updateAttemptForTransition(
  tx: DbOrTx,
  attempt: AttemptRow,
  input: AgentCallTransitionInput,
  now: Date,
): Promise<void> {
  const target = input === "call.started" ? "running" : terminalStateFor(input);
  if (!target) return;
  const updates: Partial<AttemptRow> = { attemptState: target, updatedAt: now };
  if (target === "running" && !attempt.startedAt) updates.startedAt = now;
  if (isTerminalState(target)) updates.finishedAt = now;
  await tx
    .update(agentCallAttemptTable)
    .set(updates)
    .where(eq(agentCallAttemptTable.id, attempt.id));
}

async function appendContinuation(
  tx: DbOrTx,
  call: CallRow,
  tenantId: string,
  sourceVersion: number,
  kind: AgentCallContinuationKind,
  now: Date,
): Promise<void> {
  const eventId = randomUUID();
  const resolved = resolveOutboxAppend({
    id: eventId,
    tenantId,
    eventKey: `agent-call:${call.id}:version:${sourceVersion}:continuation:${kind}`,
    eventType: "agent_call.continuation.requested",
    aggregateId: call.id,
    aggregateVersion: sourceVersion,
    payload: {
      parent_invocation_id: call.parentInvocationId,
      agent_call_id: call.id,
      source_version: sourceVersion,
      kind,
    },
    occurredAt: now,
  });
  await tx.insert(controlPlaneOutboxEvent).values({
    ...resolved,
    schemaVersion: "1.0",
    availableAt: now,
  });
  await tx.insert(controlPlaneEventDelivery).values({
    id: randomUUID(),
    eventId,
    consumerName: "invocation_continuation",
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: now,
    createdAt: now,
  });
}

async function findDuplicateIngress(
  tx: DbOrTx,
  authority: LockedAuthority,
  event: AgentCallCandidateEvent,
): Promise<AgentCallTransitionResult | null> {
  const payloadHash = canonicalHash(event.type, event.payload);
  const [byId] = await tx
    .select()
    .from(agentCallEventIngressTable)
    .where(
      and(
        eq(agentCallEventIngressTable.tenantId, authority.call.tenantId),
        eq(agentCallEventIngressTable.producerSource, authority.producerSource),
        eq(agentCallEventIngressTable.producerEventId, durableProducerEventId(event)),
      ),
    )
    .limit(1)
    .for("update");
  const [bySequence] = await tx
    .select()
    .from(agentCallEventIngressTable)
    .where(
      and(
        eq(agentCallEventIngressTable.callId, authority.call.id),
        eq(agentCallEventIngressTable.producerSequence, event.producer_sequence),
      ),
    )
    .limit(1)
    .for("update");
  const existing = byId ?? bySequence;
  if (!existing) return null;
  if (
    existing.callId !== authority.call.id ||
    existing.payloadHash !== payloadHash ||
    existing.candidateType !== event.type
  ) {
    return {
      outcome: "rejected",
      reasonCode: "ingress_idempotency_conflict",
      beforeVersionNo: authority.call.versionNo,
      afterVersionNo: authority.call.versionNo,
      finalState: authority.call.state as AgentCallState,
    };
  }
  return {
    outcome: existing.ingressState,
    reasonCode: existing.reasonCode ?? undefined,
    beforeVersionNo: existing.beforeVersionNo,
    afterVersionNo: existing.afterVersionNo,
    finalState: authority.call.state as AgentCallState,
  };
}

async function finish(
  tx: DbOrTx,
  command: ApplyAgentCallTransitionCommand,
  authority: LockedAuthority,
  now: Date,
  result: AgentCallTransitionResult,
): Promise<AgentCallTransitionResult> {
  if (!command.event) return result;
  await tx.insert(agentCallEventIngressTable).values({
    id: randomUUID(),
    callId: command.callId,
    tenantId: command.tenantId,
    producerSource: authority.producerSource,
    producerEventId: durableProducerEventId(command.event),
    producerSequence: command.event.producer_sequence,
    candidateType: command.event.type,
    payloadHash: canonicalHash(command.event.type, command.event.payload),
    payloadJson: command.event.payload,
    ingressState: result.outcome,
    receivedAt: now,
    reasonCode: result.reasonCode ?? null,
    beforeVersionNo: result.beforeVersionNo,
    afterVersionNo: result.afterVersionNo,
    processedAt: now,
  });
  return result;
}

function terminalStateFor(
  input: AgentCallTransitionInput,
): "completed" | "failed" | "cancelled" | "lost" | undefined {
  if (input === "call.completed") return "completed";
  if (input === "call.failed") return "failed";
  if (input === "call.cancelled") return "cancelled";
  if (input === "call.lost") return "lost";
  return undefined;
}

function isTerminalState(state: AgentCallState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "lost";
}

function canonicalHash(type: string, payload: unknown): string {
  const json = JSON.stringify(sortKeys({ type, payload }));
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

function durableProducerEventId(event: AgentCallCandidateEvent): string {
  const supplied = event.producer_event_id?.trim();
  if (supplied) return supplied;
  return `derived:${canonicalHash(event.type, {
    producer_sequence: event.producer_sequence,
    payload: event.payload,
  }).slice("sha256:".length)}`;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}
