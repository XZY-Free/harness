import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import type { Invocation } from "@/lib/persistence/schema/executions";
import { jobCommandTable } from "@/lib/persistence/schema/job";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { and, eq } from "drizzle-orm";

/** Inserts the durable Job terminal command while the Invocation root is locked. */
export async function bridgeInvocationTerminalToJob(
  executor: DbOrTx,
  invocation: Invocation,
  now = new Date(),
): Promise<void> {
  if (invocation.subjectType !== "job" || !invocation.jobId) return;
  const idempotencyKey = `terminal:${invocation.id}`;
  const [existing] = await executor
    .select({ id: jobCommandTable.id })
    .from(jobCommandTable)
    .where(
      and(
        eq(jobCommandTable.tenantId, invocation.tenantId),
        eq(jobCommandTable.jobId, invocation.jobId),
        eq(jobCommandTable.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) return;
  const payload = {
    invocationId: invocation.id,
    terminalState: invocation.executionState,
    terminalVersion: invocation.versionNo,
    resultRef: invocation.resultRef,
    resultDigest: invocation.resultDigest,
    errorCode: invocation.errorCode,
  };
  await executor.insert(jobCommandTable).values({
    id: randomUUID(),
    tenantId: invocation.tenantId,
    jobId: invocation.jobId,
    invocationId: invocation.id,
    commandType: "execution_terminal",
    commandState: "queued",
    idempotencyKey,
    payloadJson: payload,
    payloadHash: protocolDigest(payload),
    requestedByType: "system",
    requestedById: "invocation-terminal-bridge",
    leaseOwner: null,
    leaseExpiresAt: null,
    deliveryCount: 0,
    nextAttemptAt: now,
    lastErrorCode: null,
    resultJson: null,
    completedAt: null,
    versionNo: 1,
    createdAt: now,
    updatedAt: now,
  });
}
