import { createHash, randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  ENVIRONMENT_LEASE_STATES,
  type EnvironmentLease,
  type EnvironmentLeaseState,
  environmentLeaseTable,
} from "@/lib/persistence/schema/environment";
import { environmentDefinitionRevisionTable } from "@/lib/persistence/schema/environment-definition-revision";
import { and, asc, desc, eq, lt } from "drizzle-orm";

export class EnvironmentComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentComplianceFailed";
  }
}
export class EnvironmentLeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentLeaseConflictError";
  }
}
export class EnvironmentLeaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentLeaseStateError";
  }
}

function complianceDigest(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function capabilitiesMeet(required: unknown, actual: unknown): boolean {
  if (!required || typeof required !== "object") return true;
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(required as Record<string, unknown>).every(([key, value]) => {
    const got = (actual as Record<string, unknown>)[key];
    if (value === true) return got === true;
    if (Array.isArray(value)) return Array.isArray(got) && value.every((v) => got.includes(v));
    return got === value;
  });
}

export interface CreateEnvironmentLeaseInput {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  environmentDefinitionRevisionId: string;
  deviceId?: string | null;
  workerRef?: string | null;
  hostIdentity?: string | null;
  storageIdentity?: string | null;
  capabilitiesJson?: unknown;
  resourceManifest?: unknown;
  expiresAt?: Date;
}

export async function createEnvironmentLease(
  input: CreateEnvironmentLeaseInput,
  executor: DbOrTx = db,
): Promise<EnvironmentLease> {
  const [revision] = await executor
    .select()
    .from(environmentDefinitionRevisionTable)
    .where(
      and(
        eq(environmentDefinitionRevisionTable.tenantId, input.tenantId),
        eq(environmentDefinitionRevisionTable.id, input.environmentDefinitionRevisionId),
      ),
    )
    .limit(1);
  if (!revision) throw new EnvironmentLeaseConflictError("EnvironmentRevision 不存在或租户不匹配");
  const id = randomUUID();
  const now = new Date();
  await executor.insert(environmentLeaseTable).values({
    id,
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    environmentDefinitionRevisionId: input.environmentDefinitionRevisionId,
    deviceId: input.deviceId ?? null,
    workerRef: input.workerRef ?? null,
    hostIdentity: input.hostIdentity ?? null,
    storageIdentity: input.storageIdentity ?? null,
    leaseState: "allocated",
    readinessState: "unresolved",
    capabilitiesJson: input.capabilitiesJson ?? null,
    complianceEvidence: null,
    complianceDigest: null,
    preparedEvidence: null,
    preparedDigest: null,
    preparedAt: null,
    activationOwnershipId: null,
    resourceManifest: input.resourceManifest ?? {},
    cleanupLeaseOwner: null,
    cleanupLeaseExpiresAt: null,
    nextCleanupAt: null,
    cleanupCount: 0,
    lastErrorCode: null,
    allocatedAt: now,
    lastHeartbeatAt: null,
    expiresAt: input.expiresAt ?? new Date(now.getTime() + 90_000),
    releasedAt: null,
    versionNo: 1,
  });
  const [row] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(eq(environmentLeaseTable.id, id))
    .limit(1);
  if (!row) throw new EnvironmentLeaseConflictError("EnvironmentLease 创建后回查失败");
  return row;
}

export async function prepareEnvironmentLease(
  input: { tenantId: string; leaseId: string; capabilitiesJson: unknown; evidence?: unknown },
  executor: DbOrTx = db,
): Promise<EnvironmentLease> {
  const [lease] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, input.tenantId),
        eq(environmentLeaseTable.id, input.leaseId),
      ),
    )
    .limit(1);
  if (!lease) throw new EnvironmentLeaseConflictError(input.leaseId);
  if (!["unresolved", "preparing"].includes(lease.readinessState)) {
    throw new EnvironmentLeaseStateError(
      `EnvironmentLease 未处于可准备状态：${lease.readinessState}`,
    );
  }
  const [revision] = await executor
    .select()
    .from(environmentDefinitionRevisionTable)
    .where(eq(environmentDefinitionRevisionTable.id, lease.environmentDefinitionRevisionId))
    .limit(1);
  if (!revision || !capabilitiesMeet(revision.requiredCapabilities, input.capabilitiesJson))
    throw new EnvironmentComplianceError("实际实例不满足 EnvironmentRevision requiredCapabilities");
  const evidence = input.evidence ?? {
    capabilities: input.capabilitiesJson,
    revisionId: revision.id,
    semanticDigest: revision.semanticDigest,
  };
  const now = new Date();
  await executor
    .update(environmentLeaseTable)
    .set({
      capabilitiesJson: input.capabilitiesJson,
      complianceEvidence: evidence,
      complianceDigest: complianceDigest(evidence),
      preparedEvidence: evidence,
      preparedDigest: complianceDigest(evidence),
      preparedAt: now,
      readinessState: "prepared",
      updatedAt: now,
      versionNo: lease.versionNo + 1,
    })
    .where(eq(environmentLeaseTable.id, lease.id));
  const [updated] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(eq(environmentLeaseTable.id, lease.id))
    .limit(1);
  if (!updated) throw new EnvironmentLeaseConflictError(input.leaseId);
  return updated;
}

export async function activateEnvironmentLease(input: {
  tenantId: string;
  leaseId: string;
  ownershipId: string;
}): Promise<EnvironmentLease> {
  const [lease] = await db
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, input.tenantId),
        eq(environmentLeaseTable.id, input.leaseId),
      ),
    )
    .limit(1);
  if (!lease) throw new EnvironmentLeaseStateError("EnvironmentLease 不存在");
  if (
    lease.readinessState === "ready" &&
    lease.leaseState === "active" &&
    lease.activationOwnershipId === input.ownershipId
  )
    return lease;
  if (lease.readinessState !== "prepared")
    throw new EnvironmentLeaseStateError("EnvironmentLease 未 Prepared");
  await db
    .update(environmentLeaseTable)
    .set({
      leaseState: "active",
      readinessState: "ready",
      activationOwnershipId: input.ownershipId,
      lastHeartbeatAt: new Date(),
      versionNo: lease.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(eq(environmentLeaseTable.id, lease.id));
  const [updated] = await db
    .select()
    .from(environmentLeaseTable)
    .where(eq(environmentLeaseTable.id, lease.id))
    .limit(1);
  if (!updated) throw new EnvironmentLeaseStateError(input.leaseId);
  return updated;
}

export async function getEnvironmentLeaseById(tenantId: string, id: string, executor: DbOrTx = db) {
  const [row] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(and(eq(environmentLeaseTable.tenantId, tenantId), eq(environmentLeaseTable.id, id)))
    .limit(1);
  return row ?? null;
}
export async function getEnvironmentLeaseByAttempt(
  tenantId: string,
  invocationId: string,
  attemptId: string,
  executor: DbOrTx = db,
) {
  const [row] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, tenantId),
        eq(environmentLeaseTable.invocationId, invocationId),
        eq(environmentLeaseTable.attemptId, attemptId),
      ),
    )
    .limit(1);
  return row ?? null;
}
export async function listEnvironmentLeasesByInvocation(tenantId: string, invocationId: string) {
  return db
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, tenantId),
        eq(environmentLeaseTable.invocationId, invocationId),
      ),
    )
    .orderBy(desc(environmentLeaseTable.createdAt));
}
export async function heartbeatEnvironmentLease(tenantId: string, id: string) {
  const current = await getEnvironmentLeaseById(tenantId, id);
  if (!current || !["allocated", "active"].includes(current.leaseState))
    throw new EnvironmentLeaseStateError(id);
  await db
    .update(environmentLeaseTable)
    .set({ lastHeartbeatAt: new Date(), updatedAt: new Date(), versionNo: current.versionNo + 1 })
    .where(eq(environmentLeaseTable.id, id));
  return getEnvironmentLeaseById(tenantId, id);
}
export async function releaseEnvironmentLease(
  tenantId: string,
  id: string,
  state: Extract<EnvironmentLeaseState, "released" | "expired" | "lost"> = "released",
) {
  const current = await getEnvironmentLeaseById(tenantId, id);
  if (!current) return null;
  if (current.leaseState === state) return current;
  const now = new Date();
  await db
    .update(environmentLeaseTable)
    .set({
      leaseState: state,
      readinessState: "blocked",
      activationOwnershipId: null,
      releasedAt: now,
      updatedAt: now,
      versionNo: current.versionNo + 1,
    })
    .where(eq(environmentLeaseTable.id, id));
  return getEnvironmentLeaseById(tenantId, id);
}
