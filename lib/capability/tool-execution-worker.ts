import { createHash } from "node:crypto";
import {
  createEffectRecord,
  createEffectTargets,
  getEffectRecordByToolCall,
  listEffectTargets,
  reconcileEffect,
} from "@/lib/capability/effect-queries";
import {
  type ProductionProviderExecutorRegistry,
  ProviderExecutionError,
  createProductionProviderExecutorRegistry,
} from "@/lib/capability/provider-executor";
import { getToolCallById, updateToolCallState } from "@/lib/capability/tool-call-queries";
import {
  type ToolExecutionContract,
  computeToolExecutionContractDigest,
  parseToolExecutionContract,
} from "@/lib/capability/tool-execution-contract";
import {
  claimNextQueuedToolCall,
  recoverOneExpiredToolAttempt,
  updateToolExecutionAttempt,
} from "@/lib/capability/tool-execution-queries";
import { controlPlaneEventDelivery } from "@/lib/control-plane/events/control-plane-event-delivery";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { resolveOutboxAppend } from "@/lib/control-plane/events/outbox-append";
import { type DbOrTx, db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { type EffectType, effectRecordTable } from "@/lib/persistence/schema/effect";
import { toolSchemaRevisionTable } from "@/lib/persistence/schema/tool";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import { toolExecutionBindingTable } from "@/lib/persistence/schema/tool-execution";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import {
  type ExecutionSubject,
  recoverTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

export interface ToolExecutionWorker {
  runOnce(): Promise<"idle" | "recovered" | "executed">;
}

export function createToolExecutionWorker(
  input: {
    workerId?: string;
    leaseMs?: number;
    maxAttempts?: number;
    registry?: ProductionProviderExecutorRegistry;
    allowLoopbackHttp?: boolean;
  } = {},
): ToolExecutionWorker {
  const workerId = input.workerId ?? `tool-execution-${process.pid}`;
  const leaseMs = input.leaseMs ?? 60_000;
  const maxAttempts = input.maxAttempts ?? 3;
  const registry =
    input.registry ??
    createProductionProviderExecutorRegistry({ allowLoopbackHttp: input.allowLoopbackHttp });
  return {
    async runOnce() {
      const recovered = await recoverOneExpiredToolAttempt();
      if (recovered) {
        if (recovered.kind === "after_dispatch") {
          const call = await getToolCallById({
            tenantId: recovered.tenantId,
            toolCallId: recovered.toolCallId,
          });
          if (call) await appendToolContinuation(call.tenantId, call.invocationId, call.id);
        }
        return "recovered";
      }
      const missingContinuation = await findTerminalToolCallMissingContinuation();
      if (missingContinuation) {
        await appendToolContinuation(
          missingContinuation.tenantId,
          missingContinuation.invocationId,
          missingContinuation.id,
        );
        return "recovered";
      }
      const claimed = await claimNextQueuedToolCall({ workerId, leaseMs });
      if (!claimed) return "idle";
      const { binding, attempt } = claimed;
      const toolCall = await getToolCallById({
        tenantId: binding.tenantId,
        toolCallId: binding.toolCallId,
      });
      if (!toolCall) throw new Error("TOOL_CALL_MISSING_AFTER_CLAIM");
      const [revision] = await db
        .select()
        .from(toolSchemaRevisionTable)
        .where(eq(toolSchemaRevisionTable.id, toolCall.toolSchemaRevisionId))
        .limit(1);
      if (!revision) {
        await failBeforeDispatch(
          binding.tenantId,
          attempt.id,
          toolCall.id,
          toolCall.invocationId,
          "TOOL_SCHEMA_REVISION_MISSING_AFTER_CLAIM",
        );
        return "executed";
      }
      let contract: ToolExecutionContract;
      try {
        contract = parseToolExecutionContract(revision.executionContractJson);
      } catch {
        await failBeforeDispatch(
          binding.tenantId,
          attempt.id,
          toolCall.id,
          toolCall.invocationId,
          "EXECUTION_CONTRACT_INVALID",
        );
        return "executed";
      }
      if (
        computeToolExecutionContractDigest(contract) !== binding.executionContractDigest ||
        revision.executionContractDigest !== binding.executionContractDigest
      ) {
        await failBeforeDispatch(
          binding.tenantId,
          attempt.id,
          toolCall.id,
          toolCall.invocationId,
          "EXECUTION_CONTRACT_INTEGRITY_FAILED",
        );
        return "executed";
      }
      if (!registry.supports(binding.providerType, binding.executorKind)) {
        await failBeforeDispatch(
          binding.tenantId,
          attempt.id,
          toolCall.id,
          toolCall.invocationId,
          "PROVIDER_EXECUTOR_UNAVAILABLE",
        );
        return "executed";
      }
      const invocationBinding = await getExecutionBindingByInvocation(
        binding.tenantId,
        toolCall.invocationId,
      );
      if (!invocationBinding) {
        await failBeforeDispatch(
          binding.tenantId,
          attempt.id,
          toolCall.id,
          toolCall.invocationId,
          "EXECUTION_BINDING_MISSING",
        );
        return "executed";
      }
      let subject: ExecutionSubject;
      try {
        subject = recoverTrustedExecutionSubject(invocationBinding, binding.tenantId);
      } catch {
        await failBeforeDispatch(
          binding.tenantId,
          attempt.id,
          toolCall.id,
          toolCall.invocationId,
          "EXECUTION_SUBJECT_INVALID",
        );
        return "executed";
      }
      let credential: { authorization: string } | null = null;
      try {
        const auth = await resolveOutboundRuntimeAuth({
          tenantId: binding.tenantId,
          identityMode: binding.authMethod === "bearer" ? "bearer" : "none",
          credentialRefId: binding.credentialRefId,
        });
        credential = auth.mode === "bearer" ? { authorization: `Bearer ${auth.token}` } : null;
      } catch {
        await failBeforeDispatch(
          binding.tenantId,
          attempt.id,
          toolCall.id,
          toolCall.invocationId,
          "CREDENTIAL_UNRESOLVABLE",
        );
        return "executed";
      }
      const externalIdempotencyKey =
        contract.idempotencySupport === "header" ? `snow-tool:${toolCall.id}` : null;
      let effect = await getEffectRecordByToolCall(binding.tenantId, toolCall.id);
      if (contract.sideEffectMode === "write" && !effect) {
        const effectType = contract.providerOperationMetadata.effectType as EffectType;
        effect = await createEffectRecord({
          tenantId: binding.tenantId,
          toolCallId: toolCall.id,
          effectType,
          targetSummaryJson: { total: 1, description: "provider operation" },
          externalIdempotencyKey,
        });
        await createEffectTargets({
          tenantId: binding.tenantId,
          effectRecordId: effect.id,
          targets: [{ targetRef: `tool-call:${toolCall.id}` }],
        });
      }
      if (effect) {
        const existingTargets = await listEffectTargets(binding.tenantId, effect.id);
        if (existingTargets.length === 0) {
          await createEffectTargets({
            tenantId: binding.tenantId,
            effectRecordId: effect.id,
            targets: [{ targetRef: `tool-call:${toolCall.id}` }],
          });
        }
      }
      await updateToolExecutionAttempt({
        tenantId: binding.tenantId,
        attemptId: attempt.id,
        fromState: "claimed",
        toState: "dispatched",
        externalIdempotencyKey,
        retryClass: "undetermined",
      });
      try {
        const result = await registry.get(binding.providerType, binding.executorKind).execute({
          endpoint: binding.endpointRef ?? "",
          arguments: toolCall.argumentsRedactedJson as Record<string, unknown>,
          executionSubject: subject,
          invocationId: toolCall.invocationId,
          toolCallId: toolCall.id,
          traceId: `tool-call:${toolCall.id}:attempt:${attempt.attemptNo}`,
          externalIdempotencyKey,
          sideEffectMode: contract.sideEffectMode,
          timeoutMs: contract.timeoutMs,
          responseMaxBytes: contract.responseLimits.maxBytes,
          credential,
        });
        await db.transaction(async (tx) => {
          if (effect) {
            const targets = await listEffectTargets(binding.tenantId, effect.id, tx);
            await reconcileEffect(
              {
                tenantId: binding.tenantId,
                toolCallId: toolCall.id,
                path: "gateway",
                verificationMethod: "provider_query",
                expectedOperationId: toolCall.operationId,
                targetUpdates: targets.map((target) => ({
                  targetHash: target.targetHash,
                  targetState: "confirmed_success" as const,
                  externalResultRef: result.providerRequestRef,
                })),
                externalResultRef: result.providerRequestRef,
                evidenceJson: { status_code: result.statusCode },
                resultSummaryJson: result.result,
              },
              tx,
            );
          } else {
            await updateToolCallState(
              {
                tenantId: binding.tenantId,
                toolCallId: toolCall.id,
                toState: "succeeded",
                resultSummaryJson: result.result,
              },
              tx,
            );
          }
          await updateToolExecutionAttempt(
            {
              tenantId: binding.tenantId,
              attemptId: attempt.id,
              fromState: "dispatched",
              toState: "succeeded",
              externalIdempotencyKey,
              providerRequestRef: result.providerRequestRef,
              retryClass: "none",
              finished: true,
            },
            tx,
          );
          await appendToolContinuation(binding.tenantId, toolCall.invocationId, toolCall.id, tx);
        });
        return "executed";
      } catch (error) {
        const providerError =
          error instanceof ProviderExecutionError
            ? error
            : new ProviderExecutionError(
                "PROVIDER_EXECUTION_FAILED",
                "Provider 执行失败",
                "unknown_effect",
                true,
              );
        const attemptsExhausted = attempt.attemptNo >= maxAttempts;
        if (providerError.retryClass === "safe_transient" && !attemptsExhausted) {
          await db.transaction(async (tx) => {
            await updateToolExecutionAttempt(
              {
                tenantId: binding.tenantId,
                attemptId: attempt.id,
                fromState: "dispatched",
                toState: "failed",
                externalIdempotencyKey,
                retryClass: "safe_transient",
                errorCode: providerError.code,
                errorSummary: providerError.message,
                finished: true,
              },
              tx,
            );
            await updateToolCallState(
              {
                tenantId: binding.tenantId,
                toolCallId: toolCall.id,
                toState: "queued",
              },
              tx,
            );
          });
          return "executed";
        }
        const unknown =
          providerError.retryClass === "unknown_effect" ||
          (providerError.retryClass === "safe_transient" && attemptsExhausted && Boolean(effect));
        await db.transaction(async (tx) => {
          if (unknown && effect) {
            await tx
              .update(effectRecordTable)
              .set({ effectState: "unknown_effect", updatedAt: new Date() })
              .where(eq(effectRecordTable.id, effect.id));
          } else if (effect) {
            const targets = await listEffectTargets(binding.tenantId, effect.id, tx);
            await reconcileEffect(
              {
                tenantId: binding.tenantId,
                toolCallId: toolCall.id,
                path: "gateway",
                verificationMethod: "provider_query",
                expectedOperationId: toolCall.operationId,
                targetUpdates: targets.map((target) => ({
                  targetHash: target.targetHash,
                  targetState: "confirmed_failure" as const,
                })),
                evidenceJson: { error_code: providerError.code },
              },
              tx,
            );
          }
          await updateToolCallState(
            {
              tenantId: binding.tenantId,
              toolCallId: toolCall.id,
              toState: unknown ? "unknown_effect" : "failed",
              errorCode: providerError.code,
              errorSummary: providerError.message,
            },
            tx,
          );
          await updateToolExecutionAttempt(
            {
              tenantId: binding.tenantId,
              attemptId: attempt.id,
              fromState: "dispatched",
              toState: unknown ? "unknown" : "failed",
              externalIdempotencyKey,
              retryClass: providerError.retryClass,
              errorCode: providerError.code,
              errorSummary: providerError.message,
              finished: true,
            },
            tx,
          );
          await appendToolContinuation(binding.tenantId, toolCall.invocationId, toolCall.id, tx);
        });
        return "executed";
      }
    },
  };
}

async function failBeforeDispatch(
  tenantId: string,
  attemptId: string,
  toolCallId: string,
  invocationId: string,
  errorCode: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await updateToolExecutionAttempt(
      {
        tenantId,
        attemptId,
        fromState: "claimed",
        toState: "failed",
        retryClass: "permanent_before_dispatch",
        errorCode,
        errorSummary: "Provider dispatch 前安全失败",
        finished: true,
      },
      tx,
    );
    await updateToolCallState({ tenantId, toolCallId, toState: "failed", errorCode }, tx);
    await appendToolContinuation(tenantId, invocationId, toolCallId, tx);
  });
}

async function appendToolContinuation(
  tenantId: string,
  invocationId: string,
  toolCallId: string,
  source: DbOrTx = db,
): Promise<void> {
  const append = async (tx: DbOrTx) => {
    const eventKey = `tool-call:${toolCallId}:terminal:continuation`;
    const eventId = deterministicUuid(`event:${eventKey}`);
    const now = new Date();
    const event = resolveOutboxAppend({
      id: eventId,
      tenantId,
      eventKey,
      eventType: "tool_call.continuation.requested",
      aggregateId: toolCallId,
      aggregateVersion: 1,
      payload: {
        parent_invocation_id: invocationId,
        tool_call_id: toolCallId,
        kind: "resume_parent",
      },
      occurredAt: now,
    });
    await tx
      .insert(controlPlaneOutboxEvent)
      .values({ ...event, schemaVersion: "1.0", availableAt: now })
      .onDuplicateKeyUpdate({ set: { id: sql`${controlPlaneOutboxEvent.id}` } });
    await tx
      .insert(controlPlaneEventDelivery)
      .values({
        id: deterministicUuid(`delivery:${eventKey}:invocation_continuation`),
        eventId,
        consumerName: "invocation_continuation",
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: now,
        createdAt: now,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${controlPlaneEventDelivery.id}` } });
  };
  if (source === db) await db.transaction(append);
  else await append(source);
}

async function findTerminalToolCallMissingContinuation(): Promise<{
  id: string;
  tenantId: string;
  invocationId: string;
} | null> {
  const [candidate] = await db
    .select({
      id: toolCallTable.id,
      tenantId: toolCallTable.tenantId,
      invocationId: toolCallTable.invocationId,
    })
    .from(toolCallTable)
    .innerJoin(
      toolExecutionBindingTable,
      and(
        eq(toolExecutionBindingTable.toolCallId, toolCallTable.id),
        eq(toolExecutionBindingTable.tenantId, toolCallTable.tenantId),
      ),
    )
    .leftJoin(
      controlPlaneOutboxEvent,
      and(
        eq(controlPlaneOutboxEvent.aggregateId, toolCallTable.id),
        eq(controlPlaneOutboxEvent.eventType, "tool_call.continuation.requested"),
      ),
    )
    .where(
      and(
        inArray(toolCallTable.callState, ["succeeded", "failed", "cancelled", "unknown_effect"]),
        isNull(controlPlaneOutboxEvent.id),
      ),
    )
    .limit(1);
  return candidate ?? null;
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
