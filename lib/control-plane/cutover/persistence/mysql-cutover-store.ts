/**
 * Cutover Store 的 MySQL 实现。
 */

import { db } from "@/lib/db/client";
import {
  cutoverPlanTable,
  cutoverItemTable,
  type CutoverPlanRow,
  type CutoverItemRow,
} from "./cutover-record";
import type {
  CutoverStore,
  NewCutoverPlanInput,
  NewCutoverItemInput,
} from "./cutover-store";
import type { CutoverPlanState } from "../domain/cutover-plan";
import type { CutoverItemState, CutoverItemSubjectType } from "../domain/cutover-item";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

export const mysqlCutoverStore: CutoverStore = {
  // ─── Plan ───────────────────────────────────────────────

  async insertPlan(input) {
    await db.insert(cutoverPlanTable).values({
      id: input.id,
      tenantId: input.tenantId,
      routeSetId: input.routeSetId,
      sourceRouteSetVersionNo: input.sourceRouteSetVersionNo,
      state: input.state ?? "draft",
      createdBy: input.createdBy,
      createdAt: input.createdAt,
    });
    const [row] = await db
      .select()
      .from(cutoverPlanTable)
      .where(eq(cutoverPlanTable.id, input.id))
      .limit(1);
    if (!row) throw new Error(`insertPlan: 行未找到（id=${input.id}）`);
    return row;
  },

  async getPlanById({ tenantId, planId }) {
    const [row] = await db
      .select()
      .from(cutoverPlanTable)
      .where(
        and(eq(cutoverPlanTable.id, planId), eq(cutoverPlanTable.tenantId, tenantId)),
      )
      .limit(1);
    return row ?? null;
  },

  async getPlanByRouteSet({ tenantId, routeSetId }) {
    const [row] = await db
      .select()
      .from(cutoverPlanTable)
      .where(
        and(
          eq(cutoverPlanTable.tenantId, tenantId),
          eq(cutoverPlanTable.routeSetId, routeSetId),
        ),
      )
      .orderBy(cutoverPlanTable.createdAt)
      .limit(1);
    return row ?? null;
  },

  async updatePlanState({
    planId,
    state,
    targetRouteSetVersionNo,
    startedAt,
    completedAt,
    failedAt,
    failureReason,
  }) {
    const set: Record<string, unknown> = { state };
    if (targetRouteSetVersionNo !== undefined) set.targetRouteSetVersionNo = targetRouteSetVersionNo;
    if (startedAt !== undefined) set.startedAt = startedAt;
    if (completedAt !== undefined) set.completedAt = completedAt;
    if (failedAt !== undefined) set.failedAt = failedAt;
    if (failureReason !== undefined) set.failureReason = failureReason;

    await db
      .update(cutoverPlanTable)
      .set(set)
      .where(eq(cutoverPlanTable.id, planId));

    const [row] = await db
      .select()
      .from(cutoverPlanTable)
      .where(eq(cutoverPlanTable.id, planId))
      .limit(1);
    if (!row) throw new Error(`updatePlanState: 行未找到（id=${planId}）`);
    return row;
  },

  // ─── Item ───────────────────────────────────────────────

  async insertItems(inputs) {
    if (inputs.length === 0) return [];
    await db.insert(cutoverItemTable).values(
      inputs.map((input) => ({
        id: input.id,
        planId: input.planId,
        tenantId: input.tenantId,
        subjectType: input.subjectType,
        sourceSubjectId: input.sourceSubjectId,
        qualificationCategory: input.qualificationCategory,
        state: input.state ?? "pending",
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      })),
    );
    const ids = inputs.map((i) => i.id);
    return db
      .select()
      .from(cutoverItemTable)
      .where(inArray(cutoverItemTable.id, ids));
  },

  async listItemsByPlan(planId) {
    return db
      .select()
      .from(cutoverItemTable)
      .where(eq(cutoverItemTable.planId, planId))
      .orderBy(cutoverItemTable.createdAt);
  },

  async getItemBySubject({ planId, subjectType, sourceSubjectId }) {
    const [row] = await db
      .select()
      .from(cutoverItemTable)
      .where(
        and(
          eq(cutoverItemTable.planId, planId),
          eq(cutoverItemTable.subjectType, subjectType),
          eq(cutoverItemTable.sourceSubjectId, sourceSubjectId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async updateItemState({
    itemId,
    state,
    replacementSubjectId,
    attemptCount,
    nextAttemptAt,
    leaseOwner,
    leaseExpiresAt,
    lastError,
  }) {
    const set: Record<string, unknown> = { state, updatedAt: new Date() };
    if (replacementSubjectId !== undefined) set.replacementSubjectId = replacementSubjectId;
    if (attemptCount !== undefined) set.attemptCount = attemptCount;
    if (nextAttemptAt !== undefined) set.nextAttemptAt = nextAttemptAt;
    if (leaseOwner !== undefined) set.leaseOwner = leaseOwner;
    if (leaseExpiresAt !== undefined) set.leaseExpiresAt = leaseExpiresAt;
    if (lastError !== undefined) set.lastError = lastError;

    await db
      .update(cutoverItemTable)
      .set(set)
      .where(eq(cutoverItemTable.id, itemId));

    const [row] = await db
      .select()
      .from(cutoverItemTable)
      .where(eq(cutoverItemTable.id, itemId))
      .limit(1);
    if (!row) throw new Error(`updateItemState: 行未找到（id=${itemId}）`);
    return row;
  },

  async claimItems({ tenantId, workerId, leaseMs, batchSize, now }) {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const nowStr = now.toISOString().slice(0, 19).replace("T", " ");

    // MySQL: SELECT ... FOR UPDATE SKIP LOCKED
    // Drizzle 不直接支持 SKIP LOCKED，使用 sql 模板标签参数化查询
    const rawResult = await db.execute(
      sql`
        SELECT id FROM CutoverItem
        WHERE tenantId = ${tenantId}
          AND state IN ('pending', 'failed')
          AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${nowStr})
          AND (leaseExpiresAt IS NULL OR leaseExpiresAt < ${nowStr})
        ORDER BY createdAt ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `,
    );

    const ids = (rawResult as unknown as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return [];

    // 设置租约
    await db
      .update(cutoverItemTable)
      .set({
        leaseOwner: workerId,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(inArray(cutoverItemTable.id, ids));

    return db
      .select()
      .from(cutoverItemTable)
      .where(inArray(cutoverItemTable.id, ids));
  },

  async releaseLease({ itemId }) {
    await db
      .update(cutoverItemTable)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(cutoverItemTable.id, itemId));
  },
};
