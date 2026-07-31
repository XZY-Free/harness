/**
 * V11 Runtime 仓储。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §4.3、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W02。
 *
 * 职责：
 * - createRuntime：创建稳定 Runtime 身份（租户内 runtimeKey 唯一，区分 hosted/external）。
 * - updateRuntimeLifecycle：变更 lifecycle 状态（draft/enabled/disabled/retired 终态）。
 * - setCurrentRevision：设置 currentRevisionId（必须指向同 Runtime 的 published Revision）。
 * - getRuntime/getRuntimeByKey/listRuntimes：查询。
 *
 * RuntimeRevision 仓储（runtime-revision-queries.ts）：
 * - createDraftRevision：创建 draft Revision（revisionNo 单调递增）。
 * - publishRevision：draft → published（conformance 门禁 + 业务内容固化 + 回填 currentRevisionId）。
 * - withdrawRevision：published → withdrawn。
 *
 * 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type RuntimeKind,
  type RuntimeLifecycleState,
  type V11Runtime,
  v11Runtime,
} from "@/lib/v11/schema/runtime";
import { and, eq, isNull } from "drizzle-orm";

/** 创建稳定 Runtime 身份。 */
export async function createRuntime(params: {
  tenantId: string;
  runtimeKey: string;
  displayName: string;
  runtimeKind: RuntimeKind;
  ownerUserId: string;
  lifecycleState?: RuntimeLifecycleState;
}): Promise<V11Runtime> {
  const id = randomUUID();
  await db.insert(v11Runtime).values({
    id,
    tenantId: params.tenantId,
    runtimeKey: params.runtimeKey,
    displayName: params.displayName,
    runtimeKind: params.runtimeKind,
    ownerUserId: params.ownerUserId,
    lifecycleState: params.lifecycleState ?? "draft",
  });
  const [row] = await db.select().from(v11Runtime).where(eq(v11Runtime.id, id)).limit(1);
  if (!row) {
    throw new Error(`createRuntime: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 Runtime。不存在返回 null。 */
export async function getRuntimeById(
  tenantId: string,
  runtimeId: string,
): Promise<V11Runtime | null> {
  const [row] = await db
    .select()
    .from(v11Runtime)
    .where(and(eq(v11Runtime.tenantId, tenantId), eq(v11Runtime.id, runtimeId)))
    .limit(1);
  return row ?? null;
}

/** 按 runtimeKey 获取 Runtime。不存在返回 null。 */
export async function getRuntimeByKey(
  tenantId: string,
  runtimeKey: string,
): Promise<V11Runtime | null> {
  const [row] = await db
    .select()
    .from(v11Runtime)
    .where(and(eq(v11Runtime.tenantId, tenantId), eq(v11Runtime.runtimeKey, runtimeKey)))
    .limit(1);
  return row ?? null;
}

/** 列出租户内 Runtime（含 lifecycle 过滤；不含软删）。 */
export async function listRuntimes(
  tenantId: string,
  options?: { lifecycleState?: RuntimeLifecycleState; includeDeleted?: boolean },
): Promise<V11Runtime[]> {
  const conditions = [eq(v11Runtime.tenantId, tenantId)];
  if (options?.lifecycleState) {
    conditions.push(eq(v11Runtime.lifecycleState, options.lifecycleState));
  }
  if (!options?.includeDeleted) {
    conditions.push(isNull(v11Runtime.deletedAt));
  }
  return db
    .select()
    .from(v11Runtime)
    .where(and(...conditions));
}

/**
 * 变更 Runtime lifecycle 状态。
 *
 * 约束：
 * - retired 是终态，不可再变更（fail-closed）。
 * - draft → enabled/disabled、enabled ↔ disabled 均允许。
 * - 状态变更通过乐观锁：versionNo 不匹配返回 null。
 */
export async function updateRuntimeLifecycle(
  tenantId: string,
  runtimeId: string,
  nextState: RuntimeLifecycleState,
  expectedVersionNo: number,
): Promise<V11Runtime | null> {
  const current = await getRuntimeById(tenantId, runtimeId);
  if (!current) return null;
  if (current.lifecycleState === "retired") {
    throw new RuntimeLifecycleError(
      runtimeId,
      current.lifecycleState,
      nextState,
      "retired 是终态，不可再变更",
    );
  }
  if (current.versionNo !== expectedVersionNo) {
    return null; // 乐观锁冲突，调用方应返回 412
  }

  const result = await db
    .update(v11Runtime)
    .set({
      lifecycleState: nextState,
      versionNo: current.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11Runtime.tenantId, tenantId),
        eq(v11Runtime.id, runtimeId),
        eq(v11Runtime.versionNo, expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) return null;
  return getRuntimeById(tenantId, runtimeId);
}

/**
 * 设置 currentRevisionId（必须指向同 Runtime 的 published Revision）。
 *
 * 注意：本函数只更新字段，不校验 Revision 归属与状态；调用方（runtime-revision-queries.publishRevision）
 * 必须先校验 Revision 状态后调用本函数。
 */
export async function setCurrentRuntimeRevision(
  tenantId: string,
  runtimeId: string,
  revisionId: string | null,
  expectedVersionNo: number,
): Promise<V11Runtime | null> {
  const result = await db
    .update(v11Runtime)
    .set({
      currentRevisionId: revisionId,
      versionNo: expectedVersionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11Runtime.tenantId, tenantId),
        eq(v11Runtime.id, runtimeId),
        eq(v11Runtime.versionNo, expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) return null;
  return getRuntimeById(tenantId, runtimeId);
}

/** 软删除 Runtime（仅 draft/disabled 允许；enabled/retired 拒绝）。 */
export async function softDeleteRuntime(
  tenantId: string,
  runtimeId: string,
  expectedVersionNo: number,
): Promise<boolean> {
  const current = await getRuntimeById(tenantId, runtimeId);
  if (!current) return false;
  if (current.lifecycleState === "enabled" || current.lifecycleState === "retired") {
    throw new RuntimeLifecycleError(
      runtimeId,
      current.lifecycleState,
      current.lifecycleState,
      `${current.lifecycleState} 状态不允许软删除，请先 disable`,
    );
  }
  if (current.versionNo !== expectedVersionNo) return false;

  const result = await db
    .update(v11Runtime)
    .set({
      deletedAt: new Date(),
      versionNo: expectedVersionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11Runtime.tenantId, tenantId),
        eq(v11Runtime.id, runtimeId),
        eq(v11Runtime.versionNo, expectedVersionNo),
        isNull(v11Runtime.deletedAt),
      ),
    );

  return result[0].affectedRows > 0;
}

/** Runtime 生命周期错误。 */
export class RuntimeLifecycleError extends Error {
  constructor(
    public readonly runtimeId: string,
    public readonly fromState: RuntimeLifecycleState,
    public readonly toState: RuntimeLifecycleState,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeLifecycleError";
  }
}

/** Re-export 供外部统一从本模块引入类型。 */
export type { RuntimeKind, RuntimeLifecycleState, V11Runtime } from "@/lib/v11/schema/runtime";
export { RUNTIME_KINDS, RUNTIME_LIFECYCLE_STATES } from "@/lib/v11/schema/runtime";
