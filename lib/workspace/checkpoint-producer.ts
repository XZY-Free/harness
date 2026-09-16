import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import { getAuthorityDatabaseTime } from "@/lib/executions/persistence/execution-ownership-store";
import { environmentLeaseTable } from "@/lib/persistence/schema/environment";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { insertFilesystemCheckpoint } from "@/lib/workspace/checkpoint-store";
import { FileSnapshotStorage, type SnapshotStorageReceipt } from "@/lib/workspace/snapshot-storage";
import type { WorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { validateWorkspaceContract } from "@/lib/workspace/workspace-contract";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, eq } from "drizzle-orm";

export interface CheckpointProductionResult {
  checkpointId: string;
  manifestRef: string;
  manifestDigest: string;
  contentRootDigest: string;
}

export interface CheckpointSafePointEvidence {
  checkpointIntentId: string;
  safePointEvidenceDigest: string;
  writerQuiescenceAchievedAt: Date;
}

export interface CheckpointRequestResult {
  commandId: string;
  checkpointIntentId: string;
  deadline: Date;
  anchorDigest: string;
}

const CHECKPOINT_TIMEOUT_MS = 120_000;

/**
 * Installs the durable quiescing gate and its matching checkpoint command atomically.
 * The caller must provide a complete RecoveryAnchor constructed from formal facts;
 * arbitrary process memory is deliberately not accepted as an anchor source.
 */
export async function requestFilesystemCheckpoint(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  recoveryAnchor: Record<string, unknown>;
  requestedByType: "user" | "service" | "system";
  requestedById: string;
  checkpointIntentId?: string;
}): Promise<CheckpointRequestResult> {
  const checkpointIntentId = input.checkpointIntentId ?? randomUUID();
  const anchorDigest = computeCheckpointAnchorDigest(input.recoveryAnchor);
  return db.transaction(async (tx) => {
    const facts = await lockCheckpointFacts(
      tx,
      input.tenantId,
      input.invocationId,
      input.ownershipId,
    );
    assertRecoveryAnchor(input.recoveryAnchor, facts);
    if (facts.invocation.checkpointGate !== "open") throw new Error("CheckpointStale");
    const now = await getAuthorityDatabaseTime(tx);
    if (facts.owner.leaseExpiresAt <= now || facts.owner.executionPhase !== "executing") {
      throw new Error("NotCurrentExecutor");
    }
    const deadline = new Date(now.getTime() + CHECKPOINT_TIMEOUT_MS);
    await tx
      .update(invocationTable)
      .set({
        checkpointGate: "quiescing",
        checkpointIntentId,
        checkpointOwnerId: input.ownershipId,
        checkpointDeadline: deadline,
        checkpointProducerSequence: facts.invocation.lastProducerSequence,
        checkpointRecoveryVersion: facts.invocation.recoveryVersion,
        checkpointAnchor: input.recoveryAnchor,
        checkpointPreparedEvidence: null,
        versionNo: facts.invocation.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(invocationTable.id, input.invocationId));
    const commandId = await createInvocationCommandInTransaction(tx, {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      commandType: "checkpoint",
      idempotencyKey: `checkpoint:${checkpointIntentId}`,
      payloadJson: {
        checkpointIntentId,
        deadlineMs: deadline.getTime(),
        recoveryAnchor: input.recoveryAnchor,
        recoveryAnchorDigest: anchorDigest,
      },
      requestedByType: input.requestedByType,
      requestedById: input.requestedById,
    });
    return { commandId, checkpointIntentId, deadline, anchorDigest };
  });
}

export async function produceFilesystemCheckpoint(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  backend: WorkspaceBackend;
  storageRoot: string;
  checkpointIntentId: string;
  /** Runtime safe-point receipt obtained before this producer freezes the writer. */
  safePointEvidence: CheckpointSafePointEvidence;
}): Promise<CheckpointProductionResult> {
  const checkpointIntentId = input.checkpointIntentId;
  if (input.safePointEvidence.checkpointIntentId !== checkpointIntentId)
    throw new Error("CheckpointStale");
  const binding = await loadCheckpointFacts(input.tenantId, input.invocationId, input.ownershipId);
  if (
    binding.checkpointGate !== "quiescing" ||
    binding.checkpointIntentId !== checkpointIntentId ||
    binding.checkpointOwnerId !== input.ownershipId ||
    !binding.checkpointDeadline ||
    !binding.checkpointAnchor
  )
    throw new Error("CheckpointStale");
  const anchor = binding.checkpointAnchor as Record<string, unknown>;
  const digest = computeCheckpointAnchorDigest(anchor);
  const workspace = await getWorkspaceBindingById(input.tenantId, binding.workspaceBindingId);
  if (!workspace) throw new Error("WorkspaceNotReady");
  const contract = validateWorkspaceContract({
    bindingId: workspace.id,
    continuityMode: workspace.continuityMode,
    contractDigest: workspace.contractDigest,
    storageScopeDigest: workspace.storageScopeDigest,
    hostIdentity: workspace.hostIdentity,
    storageIdentity: workspace.storageIdentity,
    backendKind: workspace.backendKind,
    filesystemSemantics: workspace.filesystemSemantics as never,
    checkpointPolicy: workspace.checkpointPolicy as Record<string, unknown> | null,
  });
  if (contract.continuityMode !== "CHECKPOINT_RESTORABLE") throw new Error("WorkspaceNotReady");
  const grant = await input.backend.host.getWriter(
    contract.storageScopeDigest as string,
    binding.writerGeneration,
  );
  if (!grant || grant.ownershipId !== input.ownershipId) {
    await abandonFilesystemCheckpoint({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: input.ownershipId,
      checkpointIntentId,
      reasonCode: "WorkspaceWriterNotFenced",
    });
    throw new Error("WorkspaceWriterNotFenced");
  }
  let freeze: Awaited<ReturnType<WorkspaceBackend["host"]["freeze"]>> | null = null;
  let committed = false;
  let receipt: SnapshotStorageReceipt;
  try {
    freeze = await input.backend.host.freeze({ grant, checkpointIntentId, anchorDigest: digest });
    await freezeCheckpointGate({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: input.ownershipId,
      checkpointIntentId,
      binding,
      safePointEvidence: input.safePointEvidence,
    });
    receipt = await input.backend.host.snapshot({
      grant,
      checkpointIntentId,
      anchorDigest: digest,
      storage: new FileSnapshotStorage(input.storageRoot),
    });
    await recordCheckpointPreparedEvidence({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: input.ownershipId,
      checkpointIntentId,
      receipt,
      freeze,
    });
    const result = await db.transaction(async (tx) => {
      const [invocation] = await tx
        .select()
        .from(invocationTable)
        .where(
          and(
            eq(invocationTable.tenantId, input.tenantId),
            eq(invocationTable.id, input.invocationId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !invocation ||
        invocation.checkpointGate !== "frozen" ||
        invocation.checkpointIntentId !== checkpointIntentId ||
        invocation.checkpointOwnerId !== input.ownershipId ||
        invocation.checkpointDeadline === null ||
        invocation.checkpointDeadline <= (await getAuthorityDatabaseTime(tx)) ||
        invocation.checkpointProducerSequence !== binding.lastProducerSequence ||
        invocation.checkpointRecoveryVersion !== binding.recoveryVersion
      )
        throw new Error("CheckpointStale");
      const [owner] = await tx
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, input.tenantId),
            eq(executionOwnershipTable.id, input.ownershipId),
            eq(executionOwnershipTable.ownershipState, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !owner ||
        owner.attemptId !== binding.attemptId ||
        owner.leaseEpoch !== binding.leaseEpoch ||
        owner.leaseExpiresAt <= (await getAuthorityDatabaseTime(tx))
      )
        throw new Error("NotCurrentExecutor");
      const checkpointId = randomUUID();
      await insertFilesystemCheckpoint(tx, {
        id: checkpointId,
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        attemptId: binding.attemptId,
        ownershipId: input.ownershipId,
        workspaceBindingId: binding.workspaceBindingId,
        environmentDefinitionRevisionId: binding.environmentDefinitionRevisionId,
        leaseEpoch: binding.leaseEpoch,
        checkpointIntentId,
        writerGeneration: binding.writerGeneration,
        recoveryVersion: binding.recoveryVersion,
        producerSequence: binding.lastProducerSequence,
        recoveryAnchor: anchor,
        recoveryAnchorDigest: digest,
        snapshotFormat: "content_manifest",
        manifestRef: receipt.manifestRef,
        manifestDigest: receipt.manifestDigest,
        contentRootDigest: receipt.contentRootDigest,
        fileCount: receipt.fileCount,
        totalBytes: receipt.totalBytes,
        filesystemSemantics: workspace.filesystemSemantics,
        storageEvidence: {
          ...receipt,
          checkpointIntentId,
          writerGeneration: binding.writerGeneration,
          freeze,
        },
        committedAt: await getAuthorityDatabaseTime(tx),
      });
      const committedAt = await getAuthorityDatabaseTime(tx);
      await tx
        .update(invocationTable)
        .set({
          checkpointGate: "open",
          checkpointIntentId: null,
          checkpointOwnerId: null,
          checkpointDeadline: null,
          checkpointProducerSequence: binding.lastProducerSequence,
          checkpointRecoveryVersion: binding.recoveryVersion,
          checkpointAnchor: anchor,
          checkpointPreparedEvidence: { ...receipt, checkpointId },
          versionNo: invocation.versionNo + 1,
          updatedAt: committedAt,
        })
        .where(eq(invocationTable.id, input.invocationId));
      return {
        checkpointId,
        manifestRef: receipt.manifestRef,
        manifestDigest: receipt.manifestDigest,
        contentRootDigest: receipt.contentRootDigest,
      };
    });
    committed = true;
    return result;
  } finally {
    if (!committed) {
      await abandonFilesystemCheckpoint({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        ownershipId: input.ownershipId,
        checkpointIntentId,
        reasonCode: "CheckpointStale",
      }).catch(() => undefined);
    }
    if (freeze) await input.backend.host.releaseFreeze(freeze).catch(() => undefined);
  }
}

async function freezeCheckpointGate(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  checkpointIntentId: string;
  binding: Awaited<ReturnType<typeof loadCheckpointFacts>>;
  safePointEvidence: CheckpointSafePointEvidence;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    const [owner] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, input.ownershipId),
          eq(executionOwnershipTable.ownershipState, "active"),
        ),
      )
      .for("update")
      .limit(1);
    const now = await getAuthorityDatabaseTime(tx);
    if (
      !invocation ||
      !owner ||
      owner.attemptId !== input.binding.attemptId ||
      owner.leaseEpoch !== input.binding.leaseEpoch ||
      owner.leaseExpiresAt <= now ||
      invocation.checkpointGate !== "quiescing" ||
      invocation.checkpointIntentId !== input.checkpointIntentId ||
      invocation.checkpointOwnerId !== input.ownershipId ||
      invocation.checkpointDeadline === null ||
      invocation.checkpointDeadline <= now ||
      invocation.checkpointProducerSequence !== input.binding.lastProducerSequence ||
      invocation.checkpointRecoveryVersion !== input.binding.recoveryVersion ||
      computeCheckpointAnchorDigest(invocation.checkpointAnchor) !==
        computeCheckpointAnchorDigest(input.binding.checkpointAnchor)
    )
      throw new Error("CheckpointStale");
    await tx
      .update(invocationTable)
      .set({
        checkpointGate: "frozen",
        checkpointPreparedEvidence: { safePoint: input.safePointEvidence },
        versionNo: invocation.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(invocationTable.id, invocation.id));
  });
}

async function recordCheckpointPreparedEvidence(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  checkpointIntentId: string;
  receipt: SnapshotStorageReceipt;
  freeze: unknown;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !invocation ||
      invocation.checkpointGate !== "frozen" ||
      invocation.checkpointIntentId !== input.checkpointIntentId ||
      invocation.checkpointOwnerId !== input.ownershipId
    )
      throw new Error("CheckpointStale");
    await tx
      .update(invocationTable)
      .set({
        checkpointPreparedEvidence: { receipt: input.receipt, freeze: input.freeze },
        versionNo: invocation.versionNo + 1,
        updatedAt: await getAuthorityDatabaseTime(tx),
      })
      .where(eq(invocationTable.id, invocation.id));
  });
}

export async function abandonFilesystemCheckpoint(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  checkpointIntentId: string;
  reasonCode: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !invocation ||
      invocation.checkpointIntentId !== input.checkpointIntentId ||
      invocation.checkpointOwnerId !== input.ownershipId
    )
      return;
    await tx
      .update(invocationTable)
      .set({
        checkpointGate: "open",
        checkpointIntentId: null,
        checkpointOwnerId: null,
        checkpointDeadline: null,
        checkpointPreparedEvidence: { failureCode: input.reasonCode },
        versionNo: invocation.versionNo + 1,
        updatedAt: await getAuthorityDatabaseTime(tx),
      })
      .where(eq(invocationTable.id, invocation.id));
  });
}

async function loadCheckpointFacts(tenantId: string, invocationId: string, ownershipId: string) {
  return db.transaction((tx) => lockCheckpointFacts(tx, tenantId, invocationId, ownershipId));
}

async function lockCheckpointFacts(
  tx: DbOrTx,
  tenantId: string,
  invocationId: string,
  ownershipId: string,
) {
  const [invocation] = await tx
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .for("update")
    .limit(1);
  if (!invocation) throw new Error("NotCurrentExecutor");
  const [owner] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownershipId),
        eq(executionOwnershipTable.invocationId, invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .for("update")
    .limit(1);
  if (!owner) throw new Error("NotCurrentExecutor");
  const [attempt] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, tenantId),
        eq(invocationAttemptTable.id, owner.attemptId),
        eq(invocationAttemptTable.invocationId, invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const [binding] = await tx
    .select()
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, tenantId),
        eq(executionBindingTable.invocationId, invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const [session] = await tx
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.ownershipId, owner.id),
      ),
    )
    .for("update")
    .limit(1);
  const [environmentLease] = owner.environmentLeaseId
    ? await tx
        .select()
        .from(environmentLeaseTable)
        .where(
          and(
            eq(environmentLeaseTable.tenantId, tenantId),
            eq(environmentLeaseTable.id, owner.environmentLeaseId),
            eq(environmentLeaseTable.invocationId, invocationId),
            eq(environmentLeaseTable.attemptId, owner.attemptId),
          ),
        )
        .for("update")
        .limit(1)
    : [];
  if (
    !attempt ||
    !binding ||
    binding.environmentMode !== "MANAGED" ||
    !binding.environmentDefinitionRevisionId ||
    owner.workspaceWriterGeneration === null ||
    !session ||
    session.invocationId !== invocationId ||
    session.attemptId !== owner.attemptId ||
    session.leaseEpoch !== owner.leaseEpoch ||
    session.runtimeRevisionId !== binding.runtimeRevisionId ||
    session.bindingState !== "active" ||
    !environmentLease ||
    environmentLease.environmentDefinitionRevisionId !== binding.environmentDefinitionRevisionId ||
    environmentLease.leaseState !== "active" ||
    environmentLease.readinessState !== "ready" ||
    environmentLease.activationOwnershipId !== owner.id
  ) {
    throw new Error("CheckpointStale");
  }
  return {
    invocation,
    owner,
    attempt,
    binding,
    session,
    environmentLease,
    workspaceBindingId: binding.workspaceBindingId,
    environmentDefinitionRevisionId: binding.environmentDefinitionRevisionId,
    attemptId: attempt.id,
    leaseEpoch: owner.leaseEpoch,
    writerGeneration: owner.workspaceWriterGeneration,
    recoveryVersion: invocation.recoveryVersion,
    lastProducerSequence: invocation.lastProducerSequence,
    checkpointGate: invocation.checkpointGate,
    checkpointIntentId: invocation.checkpointIntentId,
    checkpointOwnerId: invocation.checkpointOwnerId,
    checkpointDeadline: invocation.checkpointDeadline,
    checkpointAnchor: invocation.checkpointAnchor,
  };
}

function assertRecoveryAnchor(
  anchor: Record<string, unknown>,
  facts: Awaited<ReturnType<typeof lockCheckpointFacts>>,
): void {
  const expected = {
    invocationId: facts.invocation.id,
    bindingDigest: facts.binding.configHash,
    recoveryVersion: String(facts.invocation.recoveryVersion),
    producerSequence: String(facts.invocation.lastProducerSequence),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (anchor[field] !== value) throw new Error("CheckpointStale");
  }
  for (const field of [
    "consumedInputRefs",
    "actionFacts",
    "childFacts",
    "resolvedUserActionRefs",
  ]) {
    if (!Array.isArray(anchor[field])) throw new Error("CheckpointStale");
  }
  if (typeof anchor.unconsumedInputWatermark !== "string") throw new Error("CheckpointStale");
}

export function computeCheckpointAnchorDigest(anchor: unknown): string {
  return protocolDigest(anchor);
}
