/**
 * HostedProvisioningRequest Store 的 MySQL 实现。
 *
 * 专题01 冻结（runtime-only）：身份权威 (tenantId, routeScopeKey)，携带 requesterId。
 * - findActiveRequest 只按 (tenantId, routeScopeKey)。
 * - 已删除 findReadyByAgent。
 * : updateState/releaseLease 必须 WHERE leaseOwner=workerId。
 * : claimRequests 包含 running+expired lease（崩溃恢复）。
 * : 保留 runtime/route checkpoint 字段（不含 Agent publication checkpoint）。
 */

import { db } from "@/lib/db/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ProvisioningState } from "../domain/hosted-provisioning-request";
import {
  type HostedProvisioningRequestRow,
  hostedProvisioningRequestTable,
} from "./hosted-provisioning-request-record";
import type {
  HostedProvisioningRequestStore,
  NewProvisioningRequestInput,
} from "./hosted-provisioning-request-store";

export class HostedProvisioningLeaseLostError extends Error {
  constructor(params: {
    operation: "updateState" | "releaseLease";
    requestId: string;
    workerId: string;
    affectedRows: number | undefined;
  }) {
    super(
      `${params.operation}: lease owner （requestId=${params.requestId}, workerId=${params.workerId}, affectedRows=${String(params.affectedRows)}）`,
    );
    this.name = "HostedProvisioningLeaseLostError";
  }
}

export class HostedProvisioningClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedProvisioningClaimError";
  }
}

export function assertAffectedRowsExactlyOne(
  affectedRows: number | undefined,
  context: {
    operation: "updateState" | "releaseLease";
    requestId: string;
    workerId: string;
  },
): void {
  if (affectedRows !== 1) {
    throw new HostedProvisioningLeaseLostError({ ...context, affectedRows });
  }
}

export function extractClaimableRequestIds(rawResult: unknown): string[] {
  if (!Array.isArray(rawResult) || !Array.isArray(rawResult[0])) {
    throw new HostedProvisioningClaimError("claimRequests: mysql2 result tuple malformed");
  }

  const ids = rawResult[0].map((row: unknown) => {
    if (
      !row ||
      typeof row !== "object" ||
      !("id" in row) ||
      typeof row.id !== "string" ||
      row.id.length === 0
    ) {
      throw new HostedProvisioningClaimError("claimRequests: selected row id malformed");
    }
    return row.id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new HostedProvisioningClaimError("claimRequests: duplicate selected request id");
  }
  return ids;
}

export function assertClaimAffectedRows(
  affectedRows: number | undefined,
  requestIds: readonly string[],
): void {
  if (affectedRows !== requestIds.length) {
    throw new HostedProvisioningClaimError(
      `claimRequests: selected ${requestIds.length} rows but updated ${String(affectedRows)}`,
    );
  }
}

export const mysqlHostedProvisioningRequestStore: HostedProvisioningRequestStore = {
  async insert(input) {
    await db.insert(hostedProvisioningRequestTable).values({
      id: input.id,
      tenantId: input.tenantId,
      requesterId: input.requesterId,
      routeScopeKey: input.routeScopeKey,
      state: input.state ?? "pending",
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    const [row] = await db
      .select()
      .from(hostedProvisioningRequestTable)
      .where(eq(hostedProvisioningRequestTable.id, input.id))
      .limit(1);
    if (!row) throw new Error(`insert: 行未找到（id=${input.id}）`);
    return row;
  },

  async getById({ tenantId, requestId }) {
    const [row] = await db
      .select()
      .from(hostedProvisioningRequestTable)
      .where(
        and(
          eq(hostedProvisioningRequestTable.id, requestId),
          eq(hostedProvisioningRequestTable.tenantId, tenantId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async findActiveRequest({ tenantId, routeScopeKey }) {
    const [row] = await db
      .select()
      .from(hostedProvisioningRequestTable)
      .where(
        and(
          eq(hostedProvisioningRequestTable.tenantId, tenantId),
          eq(hostedProvisioningRequestTable.routeScopeKey, routeScopeKey),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async updateState({
    requestId,
    workerId,
    state,
    currentStep,
    attemptCount,
    nextAttemptAt,
    leaseOwner,
    leaseExpiresAt,
    lastError,
    lastAttemptAt,
    checkpoint,
    lastCompletedStep,
  }) {
    const set: Record<string, unknown> = { state, updatedAt: new Date() };
    if (currentStep !== undefined) set.currentStep = currentStep;
    if (attemptCount !== undefined) set.attemptCount = attemptCount;
    if (nextAttemptAt !== undefined) set.nextAttemptAt = nextAttemptAt;
    if (leaseOwner !== undefined) set.leaseOwner = leaseOwner;
    if (leaseExpiresAt !== undefined) set.leaseExpiresAt = leaseExpiresAt;
    if (lastError !== undefined) set.lastError = lastError;
    if (lastAttemptAt !== undefined) set.lastAttemptAt = lastAttemptAt;
    if (lastCompletedStep !== undefined) set.lastCompletedStep = lastCompletedStep;
    // : Step Checkpoint 字段（runtime/route；Agent publication checkpoint 已冻结删除）
    if (checkpoint) {
      if (checkpoint.runtimeId !== undefined) set.stepRuntimeId = checkpoint.runtimeId;
      if (checkpoint.runtimeRevisionId !== undefined)
        set.stepRuntimeRevisionId = checkpoint.runtimeRevisionId;
      if (checkpoint.runtimeArtifactId !== undefined)
        set.stepRuntimeArtifactId = checkpoint.runtimeArtifactId;
      if (checkpoint.runtimeAttestationIds !== undefined)
        set.stepRuntimeAttestationIds = checkpoint.runtimeAttestationIds;
      if (checkpoint.runtimePublicationRecordId !== undefined)
        set.stepRuntimePublicationRecordId = checkpoint.runtimePublicationRecordId;
      if (checkpoint.conformanceRunId !== undefined)
        set.stepConformanceRunId = checkpoint.conformanceRunId;
      if (checkpoint.routeSetId !== undefined) set.stepRouteSetId = checkpoint.routeSetId;
      if (checkpoint.routeSetVersionNo !== undefined)
        set.stepRouteSetVersionNo = checkpoint.routeSetVersionNo;
      if (checkpoint.routeId !== undefined) set.stepRouteId = checkpoint.routeId;
      if (checkpoint.routeRevisionId !== undefined)
        set.stepRouteRevisionId = checkpoint.routeRevisionId;
      if (checkpoint.routeActivationId !== undefined)
        set.stepRouteActivationId = checkpoint.routeActivationId;
      if (checkpoint.projectionVersionNo !== undefined)
        set.stepProjectionVersionNo = checkpoint.projectionVersionNo;
    }

    const result = await db
      .update(hostedProvisioningRequestTable)
      .set(set)
      .where(
        and(
          eq(hostedProvisioningRequestTable.id, requestId),
          eq(hostedProvisioningRequestTable.leaseOwner, workerId),
        ),
      );

    assertAffectedRowsExactlyOne(result[0]?.affectedRows, {
      operation: "updateState",
      requestId,
      workerId,
    });

    const [row] = await db
      .select()
      .from(hostedProvisioningRequestTable)
      .where(eq(hostedProvisioningRequestTable.id, requestId))
      .limit(1);
    if (!row) throw new Error(`updateState: 行未找到（id=${requestId}）`);
    return row;
  },

  async claimRequests({ workerId, leaseMs, batchSize, now }) {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    // nextAttemptAt/leaseExpiresAt 为 datetime(3)（毫秒精度），比较须保留毫秒，
    // 否则 saga 在同一秒内设置的 nextAttemptAt=new Date() 会被截断为秒而永不满足 nextAttemptAt<=now。
    const nowStr = now.toISOString().slice(0, 23).replace("T", " ");

    // /: 原子领取 — 含 running+expired lease（崩溃恢复）
    const ids = await db.transaction(async (tx) => {
      const rawResult = await tx.execute(
        sql`
 SELECT id FROM HostedProvisioningRequest
 WHERE (state IN ('pending', 'retryable_failed')
 AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${nowStr})
 AND (leaseExpiresAt IS NULL OR leaseExpiresAt < ${nowStr}))
 OR (state = 'running'
 AND leaseExpiresAt IS NOT NULL
 AND leaseExpiresAt < ${nowStr})
 ORDER BY createdAt ASC
 LIMIT ${batchSize}
 FOR UPDATE SKIP LOCKED
 `,
      );

      const claimableIds = extractClaimableRequestIds(rawResult);
      if (claimableIds.length === 0) return claimableIds;

      const claimResult = await tx
        .update(hostedProvisioningRequestTable)
        .set({
          state: "running",
          leaseOwner: workerId,
          leaseExpiresAt,
          lastAttemptAt: now,
          attemptCount: sql`${hostedProvisioningRequestTable.attemptCount} + 1`,
          updatedAt: now,
        })
        .where(inArray(hostedProvisioningRequestTable.id, claimableIds));

      assertClaimAffectedRows(claimResult[0]?.affectedRows, claimableIds);

      return claimableIds;
    });

    if (ids.length === 0) return [];

    return db
      .select()
      .from(hostedProvisioningRequestTable)
      .where(inArray(hostedProvisioningRequestTable.id, ids));
  },

  async releaseLease({ requestId, workerId }) {
    const result = await db
      .update(hostedProvisioningRequestTable)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hostedProvisioningRequestTable.id, requestId),
          eq(hostedProvisioningRequestTable.leaseOwner, workerId),
        ),
      );

    assertAffectedRowsExactlyOne(result[0]?.affectedRows, {
      operation: "releaseLease",
      requestId,
      workerId,
    });
  },
};
