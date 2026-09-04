import { createHash, randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { effectRecordTable } from "@/lib/persistence/schema/effect";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import {
  type ToolExecutionAttempt,
  type ToolExecutionAttemptState,
  type ToolExecutionBinding,
  toolExecutionAttemptTable,
  toolExecutionBindingTable,
} from "@/lib/persistence/schema/tool-execution";
import { and, asc, eq, inArray, lt, max } from "drizzle-orm";

export function computeEndpointFingerprint(endpointRef: string | null): string | null {
  return endpointRef
    ? `sha256:${createHash("sha256").update(endpointRef, "utf8").digest("hex")}`
    : null;
}

export async function getToolExecutionBinding(
  tenantId: string,
  toolCallId: string,
  tx?: DbOrTx,
): Promise<ToolExecutionBinding | null> {
  const [row] = await (tx ?? db)
    .select()
    .from(toolExecutionBindingTable)
    .where(
      and(
        eq(toolExecutionBindingTable.tenantId, tenantId),
        eq(toolExecutionBindingTable.toolCallId, toolCallId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createToolExecutionBinding(
  input: Omit<ToolExecutionBinding, "id" | "createdAt" | "endpointFingerprint">,
  tx?: DbOrTx,
): Promise<ToolExecutionBinding> {
  const source = tx ?? db;
  const endpointFingerprint = computeEndpointFingerprint(input.endpointRef);
  const existing = await getToolExecutionBinding(input.tenantId, input.toolCallId, source);
  if (existing) {
    const immutableFieldsMatch =
      existing.toolProviderId === input.toolProviderId &&
      existing.providerType === input.providerType &&
      existing.connectionId === input.connectionId &&
      existing.authMethod === input.authMethod &&
      existing.endpointRef === input.endpointRef &&
      existing.endpointFingerprint === endpointFingerprint &&
      existing.credentialRefId === input.credentialRefId &&
      existing.executorKind === input.executorKind &&
      existing.executionContractDigest === input.executionContractDigest;
    if (!immutableFieldsMatch) throw new Error("TOOL_EXECUTION_BINDING_IMMUTABLE_CONFLICT");
    return existing;
  }
  const id = randomUUID();
  await source.insert(toolExecutionBindingTable).values({
    ...input,
    id,
    endpointFingerprint,
  });
  const created = await getToolExecutionBinding(input.tenantId, input.toolCallId, source);
  if (!created) throw new Error("TOOL_EXECUTION_BINDING_CREATE_FAILED");
  return created;
}

export async function listToolExecutionAttempts(
  tenantId: string,
  toolCallId: string,
  tx?: DbOrTx,
): Promise<ToolExecutionAttempt[]> {
  return (tx ?? db)
    .select()
    .from(toolExecutionAttemptTable)
    .where(
      and(
        eq(toolExecutionAttemptTable.tenantId, tenantId),
        eq(toolExecutionAttemptTable.toolCallId, toolCallId),
      ),
    )
    .orderBy(asc(toolExecutionAttemptTable.attemptNo));
}

export async function claimNextQueuedToolCall(input: {
  workerId: string;
  leaseMs: number;
  now?: Date;
}): Promise<{ binding: ToolExecutionBinding; attempt: ToolExecutionAttempt } | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ toolCall: toolCallTable, binding: toolExecutionBindingTable })
      .from(toolCallTable)
      .innerJoin(
        toolExecutionBindingTable,
        and(
          eq(toolExecutionBindingTable.toolCallId, toolCallTable.id),
          eq(toolExecutionBindingTable.tenantId, toolCallTable.tenantId),
        ),
      )
      .where(eq(toolCallTable.callState, "queued"))
      .orderBy(asc(toolCallTable.createdAt), asc(toolCallTable.id))
      .limit(1)
      .for("update");
    if (!candidate) return null;
    const [sequence] = await tx
      .select({ maxAttempt: max(toolExecutionAttemptTable.attemptNo) })
      .from(toolExecutionAttemptTable)
      .where(eq(toolExecutionAttemptTable.toolCallId, candidate.toolCall.id));
    const attemptNo = Number(sequence?.maxAttempt ?? 0) + 1;
    const attemptId = randomUUID();
    await tx.insert(toolExecutionAttemptTable).values({
      id: attemptId,
      tenantId: candidate.toolCall.tenantId,
      toolCallId: candidate.toolCall.id,
      attemptNo,
      attemptState: "claimed",
      requestDigest: candidate.toolCall.argumentsHash,
      externalIdempotencyKey: null,
      retryClass: "undetermined",
      claimedBy: input.workerId,
      claimExpiresAt: new Date(now.getTime() + input.leaseMs),
      startedAt: now,
    });
    const changed = await tx
      .update(toolCallTable)
      .set({ callState: "running", startedAt: candidate.toolCall.startedAt ?? now, updatedAt: now })
      .where(
        and(
          eq(toolCallTable.tenantId, candidate.toolCall.tenantId),
          eq(toolCallTable.id, candidate.toolCall.id),
          eq(toolCallTable.callState, "queued"),
        ),
      );
    if (changed[0].affectedRows !== 1) throw new Error("TOOL_EXECUTION_CLAIM_CONFLICT");
    const [attempt] = await tx
      .select()
      .from(toolExecutionAttemptTable)
      .where(eq(toolExecutionAttemptTable.id, attemptId))
      .limit(1);
    if (!attempt) throw new Error("TOOL_EXECUTION_ATTEMPT_CREATE_FAILED");
    return { binding: candidate.binding, attempt };
  });
}

export async function updateToolExecutionAttempt(
  input: {
    tenantId: string;
    attemptId: string;
    fromState: ToolExecutionAttemptState;
    toState: ToolExecutionAttemptState;
    externalIdempotencyKey?: string | null;
    providerRequestRef?: string | null;
    retryClass: string;
    errorCode?: string | null;
    errorSummary?: string | null;
    finished?: boolean;
  },
  tx?: DbOrTx,
): Promise<ToolExecutionAttempt> {
  const source = tx ?? db;
  const changed = await source
    .update(toolExecutionAttemptTable)
    .set({
      attemptState: input.toState,
      retryClass: input.retryClass,
      externalIdempotencyKey: input.externalIdempotencyKey,
      providerRequestRef: input.providerRequestRef,
      errorCode: input.errorCode,
      errorSummary: input.errorSummary,
      ...(input.finished ? { finishedAt: new Date() } : {}),
    })
    .where(
      and(
        eq(toolExecutionAttemptTable.tenantId, input.tenantId),
        eq(toolExecutionAttemptTable.id, input.attemptId),
        eq(toolExecutionAttemptTable.attemptState, input.fromState),
      ),
    );
  if (changed[0].affectedRows !== 1) throw new Error("TOOL_EXECUTION_ATTEMPT_STATE_CONFLICT");
  const [row] = await source
    .select()
    .from(toolExecutionAttemptTable)
    .where(eq(toolExecutionAttemptTable.id, input.attemptId))
    .limit(1);
  if (!row) throw new Error("TOOL_EXECUTION_ATTEMPT_MISSING");
  return row;
}

export async function recoverOneExpiredToolAttempt(now = new Date()): Promise<{
  kind: "before_dispatch" | "after_dispatch";
  tenantId: string;
  toolCallId: string;
} | null> {
  return db.transaction(async (tx) => {
    const [expired] = await tx
      .select()
      .from(toolExecutionAttemptTable)
      .where(
        and(
          lt(toolExecutionAttemptTable.claimExpiresAt, now),
          inArray(toolExecutionAttemptTable.attemptState, ["claimed", "dispatched"]),
        ),
      )
      .orderBy(asc(toolExecutionAttemptTable.claimExpiresAt))
      .limit(1)
      .for("update");
    if (!expired) return null;
    const afterDispatch = expired.attemptState === "dispatched";
    const [toolCall] = await tx
      .select()
      .from(toolCallTable)
      .where(
        and(eq(toolCallTable.tenantId, expired.tenantId), eq(toolCallTable.id, expired.toolCallId)),
      )
      .limit(1);
    if (
      afterDispatch &&
      toolCall &&
      ["succeeded", "failed", "cancelled", "unknown_effect"].includes(toolCall.callState)
    ) {
      const recoveredState =
        toolCall.callState === "succeeded"
          ? "succeeded"
          : toolCall.callState === "unknown_effect"
            ? "unknown"
            : "failed";
      await tx
        .update(toolExecutionAttemptTable)
        .set({
          attemptState: recoveredState,
          retryClass: recoveredState === "unknown" ? "unknown_effect" : "recovered_terminal",
          errorCode: toolCall.errorCode,
          errorSummary: toolCall.errorSummary,
          finishedAt: now,
        })
        .where(eq(toolExecutionAttemptTable.id, expired.id));
      return {
        kind: "after_dispatch",
        tenantId: expired.tenantId,
        toolCallId: expired.toolCallId,
      };
    }
    await tx
      .update(toolExecutionAttemptTable)
      .set({
        attemptState: afterDispatch ? "unknown" : "failed",
        retryClass: afterDispatch ? "unknown_effect" : "safe_before_dispatch",
        errorCode: afterDispatch ? "WORKER_LOST_AFTER_DISPATCH" : "WORKER_LOST_BEFORE_DISPATCH",
        errorSummary: afterDispatch
          ? "Worker lease 在 Provider dispatch 后过期，外部副作用状态未知"
          : "Worker lease 在 Provider dispatch 前过期",
        finishedAt: now,
      })
      .where(eq(toolExecutionAttemptTable.id, expired.id));
    await tx
      .update(toolCallTable)
      .set({
        callState: afterDispatch ? "unknown_effect" : "queued",
        errorCode: afterDispatch ? "WORKER_LOST_AFTER_DISPATCH" : null,
        errorSummary: afterDispatch ? "Provider dispatch 后执行器失联，禁止自动重放" : null,
        ...(afterDispatch ? { finishedAt: now } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(toolCallTable.tenantId, expired.tenantId),
          eq(toolCallTable.id, expired.toolCallId),
          eq(toolCallTable.callState, "running"),
        ),
      );
    if (afterDispatch) {
      await tx
        .update(effectRecordTable)
        .set({ effectState: "unknown_effect", updatedAt: now })
        .where(
          and(
            eq(effectRecordTable.tenantId, expired.tenantId),
            eq(effectRecordTable.toolCallId, expired.toolCallId),
            eq(effectRecordTable.effectState, "not_started"),
          ),
        );
    }
    return {
      kind: afterDispatch ? "after_dispatch" : "before_dispatch",
      tenantId: expired.tenantId,
      toolCallId: expired.toolCallId,
    };
  });
}
