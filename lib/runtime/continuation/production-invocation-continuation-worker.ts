import { resumeAgentCallFromUserAction } from "@/lib/agents/calls/application/resume-agent-call-from-user-action";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { createOutboxRelayWorker } from "@/lib/control-plane/events/outbox-relay-worker";
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { recordAuditEvent } from "@/lib/identity/audit";
import { auditEvent } from "@/lib/persistence/schema/audit";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { resumeHarnessInvocation } from "@/lib/runtime/application/production-resume-harness-invocation";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { coordinateAgentInputRequired } from "@/lib/runtime/harness-loop/coordinate-agent-input-required";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { getLatestProducerSequence } from "@/lib/runtime/recovery-queries";
import {
  type ExecutionSubject,
  recoverTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";
import { and, eq } from "drizzle-orm";
import {
  INVOCATION_CONTINUATION_CONSUMER,
  INVOCATION_CONTINUATION_LEASE_MS,
  INVOCATION_CONTINUATION_MAX_ATTEMPTS,
  INVOCATION_CONTINUATION_RETRY_DELAYS_MS,
  InvocationContinuationPermanentError,
  classifyInvocationContinuationError,
  createInvocationContinuationHandler,
} from "./invocation-continuation";

const handler = createInvocationContinuationHandler({
  getAgentCall: (params) => mysqlAgentCallStore.getById(params),
  coordinateWaitingUser: coordinateAgentInputRequired,
  resumeParent: resumeHarnessInvocation,
  async resumeAgentFromUserAction(params) {
    const [request] = await db
      .select()
      .from(userActionRequestTable)
      .where(
        and(
          eq(userActionRequestTable.id, params.requestId),
          eq(userActionRequestTable.tenantId, params.tenantId),
          eq(userActionRequestTable.requestState, "resolved"),
        ),
      )
      .limit(1);
    if (!request || request.invocationId === null) {
      throw new InvocationContinuationPermanentError(
        "USER_ACTION_REQUEST_MISSING",
        "已解析 Agent UserActionRequest 不存在",
      );
    }
    const prompt = asRecord(request.promptJson);
    if (prompt?.agent_call_id !== params.agentCallId || request.resolution !== "submit") {
      throw new InvocationContinuationPermanentError(
        "USER_ACTION_REQUEST_MISMATCH",
        "Agent UserActionRequest 与 continuation 不一致",
      );
    }
    const binding = await getExecutionBindingByInvocation(params.tenantId, request.invocationId);
    if (!binding) {
      throw new InvocationContinuationPermanentError(
        "EXECUTION_BINDING_MISSING",
        "ExecutionBinding 不存在",
      );
    }
    let executionSubject: ExecutionSubject;
    try {
      executionSubject = recoverTrustedExecutionSubject(binding, params.tenantId);
    } catch (error) {
      throw new InvocationContinuationPermanentError(
        "EXECUTION_SUBJECT_MISMATCH",
        error instanceof Error ? error.message : "可信主体无法恢复",
      );
    }
    await resumeAgentCallFromUserAction({
      tenantId: params.tenantId,
      request,
      responseRedactedJson: request.responseRedactedJson,
      executionSubject,
    });
  },
  async resumeAfterAgentResponse(params) {
    const call = await mysqlAgentCallStore.getById({
      tenantId: params.tenantId,
      callId: params.agentCallId,
    });
    // 用户回答已由同一 AgentCall/Session 接受；终态事件会另发 resume_parent。
    if (!call || call.state === "running") return;
    await resumeHarnessInvocation(params);
  },
});

export function createProductionInvocationContinuationWorker(workerId?: string) {
  return createOutboxRelayWorker(
    handler,
    {
      workerId: workerId ?? `invocation-continuation-${process.pid}`,
      consumerName: INVOCATION_CONTINUATION_CONSUMER,
      batchSize: 8,
      leaseMs: INVOCATION_CONTINUATION_LEASE_MS,
      renewIntervalMs: 30_000,
      pollIntervalMs: 2_000,
      maxAttempts: INVOCATION_CONTINUATION_MAX_ATTEMPTS,
      baseBackoffMs: INVOCATION_CONTINUATION_RETRY_DELAYS_MS[0],
      maxBackoffMs: INVOCATION_CONTINUATION_RETRY_DELAYS_MS.at(-1) ?? 21_600_000,
      retryScheduleMs: INVOCATION_CONTINUATION_RETRY_DELAYS_MS,
    },
    {
      classifyError: classifyInvocationContinuationError,
      async onDeadLetter({ delivery, event, errorCode, errorSummary }) {
        const payload = asRecord(event.payloadJson);
        const invocationId =
          typeof payload?.parent_invocation_id === "string" ? payload.parent_invocation_id : null;
        if (!invocationId) return;
        const auditRequestId = `continuation-dead-letter-${event.id}`;
        const [existingAudit] = await db
          .select({ id: auditEvent.id })
          .from(auditEvent)
          .where(
            and(eq(auditEvent.tenantId, event.tenantId), eq(auditEvent.requestId, auditRequestId)),
          )
          .limit(1);
        if (!existingAudit) {
          await recordAuditEvent({
            actor: {
              tenantId: event.tenantId,
              actorType: "system",
              actorId: "invocation_continuation",
            },
            actionType: "invocation.continuation.dead_letter",
            targetType: "invocation",
            targetId: invocationId,
            reason: errorSummary,
            outcome: "failed",
            metadataRedacted: {
              priority: "high",
              error_code: errorCode,
              delivery_id: delivery.id,
              event_id: event.id,
              manual_intervention_required: true,
            },
            requestId: auditRequestId,
          });
        }
        const invocation = await getInvocationById(event.tenantId, invocationId);
        if (!invocation || isTerminal(invocation.executionState)) return;
        const sequence = ((await getLatestProducerSequence(event.tenantId, invocationId)) ?? 0) + 1;
        await ingressEventBatch({
          tenantId: event.tenantId,
          invocationId,
          producerSequenceStart: sequence,
          events: [
            {
              producer_event_id: `continuation-dead-letter-${event.id}`,
              producer_sequence: sequence,
              type: "execution.failed",
              schema_version: 1,
              occurred_at: new Date().toISOString(),
              payload: {
                error_code: `CONTINUATION_DEAD_LETTER:${errorCode}`,
                error_summary: errorSummary,
                manual_intervention_required: true,
              },
            },
          ],
        });
      },
    },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "lost";
}
