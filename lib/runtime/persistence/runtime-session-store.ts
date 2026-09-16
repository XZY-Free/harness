/** RuntimeSessionBinding persistence: one logical session per ownership generation. */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  type RuntimeSessionBinding,
  type RuntimeSessionBindingState,
  type RuntimeSessionIntentType,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { RuntimeSessionBindingNotFoundError } from "@/lib/runtime/errors";
import { canonicalizeJson } from "@/lib/runtime/runtime-protocol";
import { and, desc, eq } from "drizzle-orm";

export type SessionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreateRuntimeSessionBindingInput {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  ownershipId: string;
  runtimeRevisionId: string;
  leaseEpoch: number;
  intentType: RuntimeSessionIntentType;
  startIntentKey: string;
  semanticRequestJson?: unknown;
  semanticRequestDigest?: string | null;
  runtimeCapabilitiesJson?: unknown;
}

export async function createRuntimeSessionBinding(
  input: CreateRuntimeSessionBindingInput,
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding> {
  if (input.startIntentKey !== `start:${input.ownershipId}`) {
    throw new Error("StartIntentConflict");
  }
  if (
    (input.semanticRequestJson === undefined) !==
    (input.semanticRequestDigest === undefined || input.semanticRequestDigest === null)
  ) {
    throw new Error("RuntimeSessionBinding semantic request 必须成对冻结");
  }
  const id = randomUUID();
  const intentFrozenAt = input.semanticRequestJson === undefined ? null : new Date();
  await executor.insert(runtimeSessionBindingTable).values({
    id,
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    ownershipId: input.ownershipId,
    runtimeRevisionId: input.runtimeRevisionId,
    leaseEpoch: input.leaseEpoch,
    bindingState: "prepared",
    intentType: input.intentType,
    startIntentKey: input.startIntentKey,
    semanticRequestJson: input.semanticRequestJson ?? null,
    semanticRequestDigest: input.semanticRequestDigest ?? null,
    intentFrozenAt,
    remoteSessionRef: null,
    remoteExecutionRef: null,
    runtimeCapabilitiesJson: input.runtimeCapabilitiesJson ?? null,
    transportAcknowledgement: null,
    acknowledgedAt: null,
    startedEventId: null,
    dispatchCount: 0,
    nextDispatchAt: null,
    dispatchLeaseOwner: null,
    dispatchLeaseExpiresAt: null,
    lastDispatchAt: null,
    lastErrorCode: null,
    closedAt: null,
    versionNo: 1,
  });
  const row = await getRuntimeSessionBindingById(input.tenantId, id, executor);
  if (!row) throw new RuntimeSessionBindingNotFoundError(id);
  return row;
}

export async function getRuntimeSessionBindingById(
  tenantId: string,
  id: string,
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding | null> {
  const [row] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(eq(runtimeSessionBindingTable.tenantId, tenantId), eq(runtimeSessionBindingTable.id, id)),
    )
    .limit(1);
  return row ?? null;
}

export async function getRuntimeSessionBindingByStartIntent(
  tenantId: string,
  startIntentKey: string,
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding | null> {
  const [row] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.startIntentKey, startIntentKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getRuntimeSessionBindingByOwnership(
  tenantId: string,
  ownershipId: string,
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding | null> {
  const [row] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.ownershipId, ownershipId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getRuntimeSessionBindingByAttempt(
  tenantId: string,
  attemptId: string,
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding | null> {
  const [row] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.attemptId, attemptId),
      ),
    )
    .orderBy(desc(runtimeSessionBindingTable.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getRuntimeSessionBindingsByInvocation(
  tenantId: string,
  invocationId: string,
): Promise<RuntimeSessionBinding[]> {
  return db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.invocationId, invocationId),
      ),
    )
    .orderBy(desc(runtimeSessionBindingTable.createdAt));
}

export async function updateRuntimeSessionDispatch(
  tenantId: string,
  id: string,
  patch: {
    bindingState?: RuntimeSessionBindingState;
    semanticRequestJson?: unknown;
    semanticRequestDigest?: string | null;
    remoteSessionRef?: string | null;
    remoteExecutionRef?: string | null;
    transportAcknowledgement?: unknown;
    acknowledgedAt?: Date | null;
    startedEventId?: string | null;
    nextDispatchAt?: Date | null;
    dispatchLeaseOwner?: string | null;
    dispatchLeaseExpiresAt?: Date | null;
    lastErrorCode?: string | null;
  },
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding> {
  const current = await getRuntimeSessionBindingById(tenantId, id, executor);
  if (!current) throw new RuntimeSessionBindingNotFoundError(id);
  const semanticRequestChanged =
    patch.semanticRequestJson !== undefined || patch.semanticRequestDigest !== undefined;
  if (semanticRequestChanged) {
    if (patch.semanticRequestJson === undefined || !patch.semanticRequestDigest) {
      throw new Error("RuntimeSessionBinding semantic request 必须成对冻结");
    }
    if (
      current.semanticRequestDigest &&
      current.semanticRequestDigest !== patch.semanticRequestDigest
    ) {
      throw new Error("StartIntentConflict");
    }
    if (
      current.semanticRequestJson &&
      canonicalizeJson(current.semanticRequestJson) !== canonicalizeJson(patch.semanticRequestJson)
    ) {
      throw new Error("StartIntentConflict");
    }
  }
  if (
    current.remoteSessionRef &&
    patch.remoteSessionRef &&
    current.remoteSessionRef !== patch.remoteSessionRef
  ) {
    throw new Error("ProtocolViolation");
  }
  if (
    current.remoteExecutionRef &&
    patch.remoteExecutionRef &&
    current.remoteExecutionRef !== patch.remoteExecutionRef
  ) {
    throw new Error("ProtocolViolation");
  }
  if (
    ["closed", "lost"].includes(current.bindingState) &&
    patch.bindingState &&
    patch.bindingState !== current.bindingState
  ) {
    throw new Error("RuntimeSessionMismatch");
  }
  const bindingState =
    current.bindingState === "active" && patch.bindingState === "dispatching"
      ? "active"
      : patch.bindingState;
  const intentFrozenAt = semanticRequestChanged && !current.intentFrozenAt ? new Date() : undefined;
  await executor
    .update(runtimeSessionBindingTable)
    .set({
      ...patch,
      ...(bindingState ? { bindingState } : {}),
      ...(intentFrozenAt ? { intentFrozenAt } : {}),
      versionNo: current.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(eq(runtimeSessionBindingTable.tenantId, tenantId), eq(runtimeSessionBindingTable.id, id)),
    );
  const updated = await getRuntimeSessionBindingById(tenantId, id, executor);
  if (!updated) throw new RuntimeSessionBindingNotFoundError(id);
  return updated;
}

export async function closeRuntimeSessionBinding(id: string): Promise<RuntimeSessionBinding> {
  const [current] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, id))
    .limit(1);
  if (!current) throw new RuntimeSessionBindingNotFoundError(id);
  if (current.bindingState === "closed") return current;
  await db
    .update(runtimeSessionBindingTable)
    .set({
      bindingState: "closed",
      closedAt: new Date(),
      versionNo: current.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(eq(runtimeSessionBindingTable.id, id));
  const [updated] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, id))
    .limit(1);
  if (!updated) throw new RuntimeSessionBindingNotFoundError(id);
  return updated;
}

export async function markRuntimeSessionLostInTransaction(
  executor: SessionTx,
  id: string,
): Promise<RuntimeSessionBinding> {
  const [current] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, id))
    .for("update")
    .limit(1);
  if (!current) throw new RuntimeSessionBindingNotFoundError(id);
  if (current.bindingState === "lost" || current.bindingState === "closed") return current;
  await executor
    .update(runtimeSessionBindingTable)
    .set({
      bindingState: "lost",
      closedAt: new Date(),
      versionNo: current.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(eq(runtimeSessionBindingTable.id, id));
  const [updated] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, id))
    .limit(1);
  if (!updated) throw new RuntimeSessionBindingNotFoundError(id);
  return updated;
}

export async function markRuntimeSessionLost(id: string): Promise<RuntimeSessionBinding> {
  return db.transaction((tx) => markRuntimeSessionLostInTransaction(tx, id));
}
