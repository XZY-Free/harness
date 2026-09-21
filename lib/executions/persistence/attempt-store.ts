/** InvocationAttempt persistence: infrastructure preparation and attempt state only. */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  type ExecutionSourceSnapshot,
  assertExecutionSourceSnapshot,
  executionSourceDigest,
} from "@/lib/executions/domain/preparation-source";
import { lockInvocationRootIfExists } from "@/lib/executions/persistence/execution-ownership-store";
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
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

/** 与正式 undispatched recovery lane 的安全窗口一致；到期后同一候选可被下一进程接管。 */
export const ATTEMPT_PREPARATION_LEASE_MS = 30_000 as const;

export interface AttemptPreparationClaim {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  intentKey: string;
  requestDigest: string;
  claimId: string;
  source: ExecutionSourceSnapshot;
}

export type AttemptPreparationClaimOutcome =
  | { disposition: "claimed"; attempt: InvocationAttempt; claim: AttemptPreparationClaim }
  | { disposition: "replay"; attempt: InvocationAttempt; claim: null }
  | { disposition: "busy"; attempt: InvocationAttempt; claim: null };

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
    preparationSourceJson: null,
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

/**
 * 领取 Attempt 的唯一准备槽。
 *
 * 领取事务固定锁序为 Invocation → Attempt。外部 IO 完成后的所有提交者必须把这里返回的
 * claim 原样带回；仅凭 attemptId、进程 id 或“当前还没有 Owner”都不构成写权限。
 */
export interface ClaimAttemptPreparationInput {
  source: ExecutionSourceSnapshot;
  claimId: string;
  now?: Date;
}

export async function claimAttemptPreparation(input: ClaimAttemptPreparationInput) {
  return db.transaction(async (tx): Promise<AttemptPreparationClaimOutcome> => {
    const source = assertExecutionSourceSnapshot(input.source);
    const [invocation] = await tx
      .select({ id: invocationTable.id })
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, source.tenantId),
          eq(invocationTable.id, source.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation) throw new InvocationAttemptNotFoundError(source.attemptId);
    return claimAttemptPreparationInTransaction(tx, input);
  });
}

/**
 * TX-A 内部步骤。调用方必须已按 I → A 的偏序锁定 Invocation 根；
 * 该函数不自开事务，使来源裁决、准备领取与 Lease 变更可以在同一真实事务完成。
 */
export async function claimAttemptPreparationInTransaction(
  tx: AttemptTx,
  input: ClaimAttemptPreparationInput,
): Promise<AttemptPreparationClaimOutcome> {
  const now = input.now ?? new Date();
  const source = assertExecutionSourceSnapshot(input.source);
  const requestDigest = executionSourceDigest(source);
  const [attempt] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, source.tenantId),
        eq(invocationAttemptTable.id, source.attemptId),
        eq(invocationAttemptTable.invocationId, source.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt) throw new InvocationAttemptNotFoundError(source.attemptId);
  if (
    attempt.preparationIntentKey === source.sourceOperationKey &&
    attempt.preparationRequestDigest !== null &&
    attempt.preparationRequestDigest !== requestDigest
  ) {
    throw new InvocationAttemptStateConflictError(
      attempt.id,
      attempt.attemptState,
      "PreparationIntentConflict",
    );
  }
  if (
    attempt.preparationState === "preparing" &&
    attempt.preparationClaimId !== input.claimId &&
    (attempt.preparationLeaseExpiresAt?.getTime() ?? 0) > now.getTime()
  ) {
    return { disposition: "busy", attempt, claim: null };
  }
  if (
    attempt.preparationIntentKey !== null &&
    attempt.preparationIntentKey !== source.sourceOperationKey &&
    !["pending", "prepared"].includes(attempt.preparationState)
  ) {
    throw new InvocationAttemptStateConflictError(
      attempt.id,
      attempt.attemptState,
      "PreparationSourceSuperseded",
    );
  }
  const sameSource =
    attempt.preparationIntentKey === source.sourceOperationKey &&
    attempt.preparationRequestDigest === requestDigest;
  if (sameSource && attempt.preparationSourceJson !== null) {
    const persisted = assertExecutionSourceSnapshot(attempt.preparationSourceJson);
    if (executionSourceDigest(persisted) !== requestDigest) {
      throw new InvocationAttemptStateConflictError(
        attempt.id,
        attempt.attemptState,
        "PreparationSourceCorrupt",
      );
    }
  }
  const preservePrepared = sameSource && attempt.preparationState === "prepared";
  await tx
    .update(invocationAttemptTable)
    .set({
      preparationState: preservePrepared ? "prepared" : "preparing",
      preparationIntentKey: source.sourceOperationKey,
      preparationRequestDigest: requestDigest,
      preparationSourceJson: source,
      preparationClaimId: input.claimId,
      preparationLeaseExpiresAt: new Date(now.getTime() + ATTEMPT_PREPARATION_LEASE_MS),
      nextPreparationAt: null,
      ...(!sameSource
        ? { preparationEvidence: null, preparationDigest: null, preparedAt: null }
        : {}),
      updatedAt: now,
      versionNo: attempt.versionNo + 1,
    })
    .where(eq(invocationAttemptTable.id, attempt.id));
  const [updated] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, attempt.id))
    .limit(1);
  if (!updated) throw new InvocationAttemptNotFoundError(attempt.id);
  return {
    disposition: "claimed",
    attempt: updated,
    claim: {
      tenantId: source.tenantId,
      invocationId: source.invocationId,
      attemptId: source.attemptId,
      intentKey: source.sourceOperationKey,
      requestDigest,
      claimId: input.claimId,
      source,
    },
  };
}

export async function assertAttemptPreparationClaimHeldInTransaction(
  tx: AttemptTx,
  claim: AttemptPreparationClaim,
): Promise<InvocationAttempt> {
  const [attempt] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, claim.tenantId),
        eq(invocationAttemptTable.id, claim.attemptId),
        eq(invocationAttemptTable.invocationId, claim.invocationId),
        gt(invocationAttemptTable.preparationLeaseExpiresAt, sql`CURRENT_TIMESTAMP(3)`),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !attempt ||
    !["preparing", "prepared"].includes(attempt.preparationState) ||
    attempt.preparationIntentKey !== claim.intentKey ||
    attempt.preparationRequestDigest !== claim.requestDigest ||
    attempt.preparationClaimId !== claim.claimId ||
    attempt.preparationSourceJson === null
  ) {
    throw new InvocationAttemptStateConflictError(
      claim.attemptId,
      attempt?.attemptState ?? "lost",
      "PreparationClaimSuperseded",
    );
  }
  const persistedSource = assertExecutionSourceSnapshot(attempt.preparationSourceJson);
  if (
    executionSourceDigest(persistedSource) !== claim.requestDigest ||
    executionSourceDigest(claim.source) !== claim.requestDigest
  ) {
    throw new InvocationAttemptStateConflictError(
      claim.attemptId,
      attempt.attemptState,
      "PreparationSourceCorrupt",
    );
  }
  return attempt;
}

/** 外部 IO 返回后的只读领取复核；固定以 Invocation 根开始事务。 */
export async function assertAttemptPreparationClaimHeld(
  claim: AttemptPreparationClaim,
): Promise<InvocationAttempt> {
  return db.transaction(async (tx) => {
    if (!(await lockInvocationRootIfExists(tx, claim.tenantId, claim.invocationId))) {
      throw new InvocationAttemptStateConflictError(
        claim.attemptId,
        "lost",
        "PreparationClaimSuperseded",
      );
    }
    return assertAttemptPreparationClaimHeldInTransaction(tx, claim);
  });
}

/** Persists candidate preparation evidence before Ownership can be acquired. */
export async function markAttemptPreparedInTransaction(
  tx: AttemptTx,
  input: {
    attemptId: string;
    evidence: unknown;
    digest: string;
    now?: Date;
    preparationClaim: AttemptPreparationClaim;
  },
): Promise<InvocationAttempt> {
  const current = await assertAttemptPreparationClaimHeldInTransaction(tx, input.preparationClaim);
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
