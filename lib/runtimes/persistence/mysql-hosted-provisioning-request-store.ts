/**
 * HostedProvisioningRequest Store 的 MySQL 实现。
 */

import { db } from "@/lib/db/client";
import {
  hostedProvisioningRequestTable,
  type HostedProvisioningRequestRow,
} from "./hosted-provisioning-request-record";
import type {
  HostedProvisioningRequestStore,
  NewProvisioningRequestInput,
} from "./hosted-provisioning-request-store";
import type { ProvisioningState } from "../domain/hosted-provisioning-request";
import { and, eq, inArray, sql } from "drizzle-orm";

export const mysqlHostedProvisioningRequestStore: HostedProvisioningRequestStore = {
  async insert(input) {
    await db.insert(hostedProvisioningRequestTable).values({
      id: input.id,
      tenantId: input.tenantId,
      agentId: input.agentId,
      agentRevisionId: input.agentRevisionId,
      routeScopeKey: input.routeScopeKey,
      desiredRuntimeKey: input.desiredRuntimeKey,
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

  async findActiveRequest({ tenantId, agentRevisionId, routeScopeKey, desiredRuntimeKey }) {
    const [row] = await db
      .select()
      .from(hostedProvisioningRequestTable)
      .where(
        and(
          eq(hostedProvisioningRequestTable.tenantId, tenantId),
          eq(hostedProvisioningRequestTable.agentRevisionId, agentRevisionId),
          eq(hostedProvisioningRequestTable.routeScopeKey, routeScopeKey),
          eq(hostedProvisioningRequestTable.desiredRuntimeKey, desiredRuntimeKey),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async findReadyByAgent({ tenantId, agentId, routeScopeKey }) {
    const [row] = await db
      .select()
      .from(hostedProvisioningRequestTable)
      .where(
        and(
          eq(hostedProvisioningRequestTable.tenantId, tenantId),
          eq(hostedProvisioningRequestTable.agentId, agentId),
          eq(hostedProvisioningRequestTable.routeScopeKey, routeScopeKey),
          eq(hostedProvisioningRequestTable.state, "ready"),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async updateState({
    requestId,
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
    // §6.2: Step Checkpoint 字段
    if (lastCompletedStep !== undefined) set.lastCompletedStep = lastCompletedStep;
    if (checkpoint) {
      if (checkpoint.agentRevisionId !== undefined) set.stepAgentRevisionId = checkpoint.agentRevisionId;
      if (checkpoint.agentPublicationRecordId !== undefined) set.stepAgentPublicationRecordId = checkpoint.agentPublicationRecordId;
      if (checkpoint.agentAttestationId !== undefined) set.stepAgentAttestationId = checkpoint.agentAttestationId;
      if (checkpoint.runtimeRevisionId !== undefined) set.stepRuntimeRevisionId = checkpoint.runtimeRevisionId;
      if (checkpoint.runtimePublicationRecordId !== undefined) set.stepRuntimePublicationRecordId = checkpoint.runtimePublicationRecordId;
      if (checkpoint.runtimeAttestationId !== undefined) set.stepRuntimeAttestationId = checkpoint.runtimeAttestationId;
      if (checkpoint.conformanceRunId !== undefined) set.stepConformanceRunId = checkpoint.conformanceRunId;
      if (checkpoint.routeSetId !== undefined) set.stepRouteSetId = checkpoint.routeSetId;
      if (checkpoint.routeSetVersionNo !== undefined) set.stepRouteSetVersionNo = checkpoint.routeSetVersionNo;
      if (checkpoint.routeRevisionId !== undefined) set.stepRouteRevisionId = checkpoint.routeRevisionId;
      if (checkpoint.routeActivationId !== undefined) set.stepRouteActivationId = checkpoint.routeActivationId;
    }

    await db
      .update(hostedProvisioningRequestTable)
      .set(set)
      .where(eq(hostedProvisioningRequestTable.id, requestId));

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
    const nowStr = now.toISOString().slice(0, 19).replace("T", " ");

    // §6.4: 原子领取 — SELECT FOR UPDATE SKIP LOCKED + UPDATE 必须在同一事务中
    const ids = await db.transaction(async (tx) => {
      const rawResult = await tx.execute(
        sql`
          SELECT id FROM HostedProvisioningRequest
          WHERE state IN ('pending', 'retryable_failed')
            AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${nowStr})
            AND (leaseExpiresAt IS NULL OR leaseExpiresAt < ${nowStr})
          ORDER BY createdAt ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `,
      );

      const claimableIds = (rawResult as unknown as { id: string }[]).map((r) => r.id);
      if (claimableIds.length === 0) return claimableIds;

      await tx
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

      return claimableIds;
    });

    if (ids.length === 0) return [];

    return db
      .select()
      .from(hostedProvisioningRequestTable)
      .where(inArray(hostedProvisioningRequestTable.id, ids));
  },

  async releaseLease({ requestId }) {
    await db
      .update(hostedProvisioningRequestTable)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(hostedProvisioningRequestTable.id, requestId));
  },
};
