/** InvocationAttempt persistence: infrastructure preparation and attempt state only. */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  type InvocationAttempt,
  type InvocationAttemptState,
  type InvocationPreparationState,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import {
  InvocationAttemptNotFoundError,
  InvocationAttemptStateConflictError,
} from "@/lib/runtime/errors";
import { and, asc, desc, eq, sql } from "drizzle-orm";

export type AttemptTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const transitions: Record<InvocationAttemptState, InvocationAttemptState[]> = {
  queued: ["running", "cancelled", "failed", "lost"],
  running: ["suspended", "completed", "failed", "cancelled", "lost"],
  suspended: ["running", "cancelled", "failed", "lost"],
  completed: [],
  failed: [],
  cancelled: [],
  lost: [],
};

export interface CreateAttemptParams {
  invocationId: string;
  tenantId?: string;
  retryReasonCode?: string | null;
  filesystemCheckpointId?: string | null;
  resumeAnchor?: unknown;
  resumeAnchorDigest?: string | null;
}

async function resolveTenantId(invocationId: string, executor: DbOrTx): Promise<string> {
  const [invocation] = await executor
    .select({ tenantId: invocationTable.tenantId })
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId))
    .limit(1);
  if (!invocation) throw new InvocationAttemptNotFoundError(invocationId);
  return invocation.tenantId;
}

async function createAttemptIn(
  executor: DbOrTx,
  params: CreateAttemptParams,
): Promise<InvocationAttempt> {
  const tenantId = params.tenantId ?? (await resolveTenantId(params.invocationId, executor));
  const [maxRow] = await executor
    .select({ maxNo: sql<number>`COALESCE(MAX(${invocationAttemptTable.attemptNo}), 0)` })
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, tenantId),
        eq(invocationAttemptTable.invocationId, params.invocationId),
      ),
    );
  const attemptId = randomUUID();
  await executor.insert(invocationAttemptTable).values({
    id: attemptId,
    tenantId,
    invocationId: params.invocationId,
    attemptNo: (maxRow?.maxNo ?? 0) + 1,
    attemptState: "queued",
    preparationState: "pending",
    preparationEvidence: null,
    preparationDigest: null,
    preparedAt: null,
    preparationIntentKey: null,
    preparationRequestDigest: null,
    preparationClaimId: null,
    preparationLeaseExpiresAt: null,
    nextPreparationAt: null,
    preparationCount: 0,
    resumeAnchor: params.resumeAnchor ?? null,
    resumeAnchorDigest: params.resumeAnchorDigest ?? null,
    filesystemCheckpointId: params.filesystemCheckpointId ?? null,
    retryReasonCode: params.retryReasonCode ?? null,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorSummary: null,
    versionNo: 1,
  });
  const [row] = await executor
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, attemptId))
    .limit(1);
  if (!row) throw new InvocationAttemptNotFoundError(attemptId);
  return row;
}

export function createAttempt(params: CreateAttemptParams): Promise<InvocationAttempt> {
  return db.transaction((tx) => createAttemptIn(tx, params));
}

export function createAttemptInternal(
  tx: AttemptTx,
  params: CreateAttemptParams,
): Promise<InvocationAttempt> {
  return createAttemptIn(tx, params);
}

/** Persists candidate preparation evidence before Ownership can be acquired. */
export async function markAttemptPreparedInTransaction(
  tx: AttemptTx,
  input: { attemptId: string; evidence: unknown; digest: string; now?: Date },
): Promise<InvocationAttempt> {
  const [current] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, input.attemptId))
    .for("update")
    .limit(1);
  if (!current) throw new InvocationAttemptNotFoundError(input.attemptId);
  if (current.preparationState === "prepared") return current;
  if (current.preparationState === "failed")
    throw new InvocationAttemptStateConflictError(
      input.attemptId,
      current.attemptState,
      "failed preparation cannot be reused",
    );
  const now = input.now ?? new Date();
  await tx
    .update(invocationAttemptTable)
    .set({
      preparationState: "prepared",
      preparationEvidence: input.evidence,
      preparationDigest: input.digest,
      preparedAt: now,
      preparationCount: current.preparationCount + 1,
      nextPreparationAt: null,
      updatedAt: now,
      versionNo: current.versionNo + 1,
    })
    .where(eq(invocationAttemptTable.id, input.attemptId));
  const [updated] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, input.attemptId))
    .limit(1);
  if (!updated) throw new InvocationAttemptNotFoundError(input.attemptId);
  return updated;
}

export async function getAttemptById(attemptId: string): Promise<InvocationAttempt | null> {
  const [row] = await db
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, attemptId))
    .limit(1);
  return row ?? null;
}

export async function getLatestAttempt(invocationId: string): Promise<InvocationAttempt | null> {
  const [row] = await db
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.invocationId, invocationId))
    .orderBy(desc(invocationAttemptTable.attemptNo))
    .limit(1);
  return row ?? null;
}

export async function getAttemptsByInvocation(invocationId: string): Promise<InvocationAttempt[]> {
  return db
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.invocationId, invocationId))
    .orderBy(asc(invocationAttemptTable.attemptNo));
}

export interface UpdateAttemptStateOptions {
  preparationState?: InvocationPreparationState;
  preparationEvidence?: unknown;
  preparationDigest?: string | null;
  preparedAt?: Date | null;
  filesystemCheckpointId?: string | null;
  resumeAnchor?: unknown;
  resumeAnchorDigest?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  errorCode?: string | null;
  errorSummary?: string | null;
}

export async function updateAttemptState(
  tx: AttemptTx,
  attemptId: string,
  newState: InvocationAttemptState,
  options: UpdateAttemptStateOptions = {},
): Promise<InvocationAttempt> {
  const [current] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, attemptId))
    .for("update")
    .limit(1);
  if (!current) throw new InvocationAttemptNotFoundError(attemptId);
  if (!transitions[current.attemptState].includes(newState)) {
    throw new InvocationAttemptStateConflictError(attemptId, current.attemptState, `→ ${newState}`);
  }
  await tx
    .update(invocationAttemptTable)
    .set({
      attemptState: newState,
      preparationState: options.preparationState,
      preparationEvidence: options.preparationEvidence,
      preparationDigest: options.preparationDigest,
      preparedAt: options.preparedAt,
      filesystemCheckpointId: options.filesystemCheckpointId,
      resumeAnchor: options.resumeAnchor,
      resumeAnchorDigest: options.resumeAnchorDigest,
      startedAt:
        newState === "running"
          ? (options.startedAt ?? current.startedAt ?? new Date())
          : options.startedAt,
      finishedAt: ["completed", "failed", "cancelled", "lost"].includes(newState)
        ? (options.finishedAt ?? new Date())
        : options.finishedAt,
      errorCode: options.errorCode,
      errorSummary: options.errorSummary,
      versionNo: current.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(eq(invocationAttemptTable.id, attemptId));
  const [updated] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, attemptId))
    .limit(1);
  if (!updated) throw new InvocationAttemptNotFoundError(attemptId);
  return updated;
}

export { transitions as ATTEMPT_ALLOWED_TRANSITIONS };
