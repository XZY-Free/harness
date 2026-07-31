/**
 * V11 RuntimeSessionBinding 仓储（S05-C02）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.11（RuntimeSessionBinding L506-508）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §6（Invocation 生命周期）
 * - ../v11-agentkit-platform-development-plan/05-runtime-dispatch-and-attempt.md S05-C02
 *
 * 职责：
 * - createSessionBinding：INSERT RuntimeSessionBinding（externalSessionRef 来自 Runtime 响应）。
 * - getSessionBindingById / getSessionBindingByExternalRef / getSessionBindingsByThread：查询。
 * - updateLastUsedAt：调用 Runtime 后刷新最近使用时间。
 * - closeSessionBinding：Turn 终态后请求 Runtime 关闭会话；平台仅标记 bindingState=closed。
 *
 * 关键约束：
 * - threadId/jobId 恰有一个非空（应用层校验，DB 不加 CHECK）。
 * - externalSessionRef 由 Runtime 颁发，平台仅持久化引用，不解析其内容。
 * - UNIQUE(runtimeRevisionId, externalSessionRef)：同一 RuntimeRevision 下外部会话引用唯一。
 * - 外部 Session 不取代 Thread，仅作为 Runtime 侧执行上下文锚点。
 */
import { db } from "@/lib/db/client";
import {
  RuntimeSessionBindingConflictError,
  RuntimeSessionBindingNotFoundError,
} from "@/lib/v11/runtime/errors";
import type { V11RuntimeSessionBinding } from "@/lib/v11/schema/runtime";
import { v11RuntimeSessionBinding } from "@/lib/v11/schema/runtime";
import { and, eq } from "drizzle-orm";

/** createSessionBinding 入参。 */
export interface CreateSessionBindingParams {
  tenantId: string;
  runtimeRevisionId: string;
  /** 会话执行时存在；后台 Job 执行时为空。 */
  threadId?: string | null;
  /** 后台执行时存在；会话执行时为空。 */
  jobId?: string | null;
  /** Runtime 颁发的外部会话引用。 */
  externalSessionRef: string;
}

/**
 * 创建 RuntimeSessionBinding。
 *
 * 流程：
 * 1. 校验 threadId/jobId 恰有一个非空。
 * 2. INSERT RuntimeSessionBinding（bindingState=active）。
 * 3. UNIQUE 冲突 → RuntimeSessionBindingConflictError（同 runtimeRevisionId+externalSessionRef 已存在）。
 *
 * @throws RuntimeSessionBindingConflictError 同 runtimeRevisionId+externalSessionRef 已存在
 */
export async function createSessionBinding(
  params: CreateSessionBindingParams,
): Promise<V11RuntimeSessionBinding> {
  // 1. 校验 threadId/jobId 恰有一个非空
  const hasThread = params.threadId !== null && params.threadId !== undefined;
  const hasJob = params.jobId !== null && params.jobId !== undefined;
  if (hasThread === hasJob) {
    throw new Error("createSessionBinding: threadId/jobId 必须恰有一个非空");
  }

  // 2. 检查同 runtimeRevisionId+externalSessionRef 是否已存在
  const [existing] = await db
    .select({ id: v11RuntimeSessionBinding.id })
    .from(v11RuntimeSessionBinding)
    .where(
      and(
        eq(v11RuntimeSessionBinding.runtimeRevisionId, params.runtimeRevisionId),
        eq(v11RuntimeSessionBinding.externalSessionRef, params.externalSessionRef),
      ),
    )
    .limit(1);
  if (existing) {
    throw new RuntimeSessionBindingConflictError(
      params.runtimeRevisionId,
      params.externalSessionRef,
    );
  }

  // 3. INSERT RuntimeSessionBinding
  await db.insert(v11RuntimeSessionBinding).values({
    tenantId: params.tenantId,
    runtimeRevisionId: params.runtimeRevisionId,
    threadId: params.threadId ?? null,
    jobId: params.jobId ?? null,
    externalSessionRef: params.externalSessionRef,
    bindingState: "active",
  });

  // 4. 回读
  const [row] = await db
    .select()
    .from(v11RuntimeSessionBinding)
    .where(
      and(
        eq(v11RuntimeSessionBinding.runtimeRevisionId, params.runtimeRevisionId),
        eq(v11RuntimeSessionBinding.externalSessionRef, params.externalSessionRef),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `createSessionBinding: RuntimeSessionBinding 行未找到（runtimeRevisionId=${params.runtimeRevisionId}, externalSessionRef=${params.externalSessionRef}）`,
    );
  }
  return row;
}

/** 按 id 获取 RuntimeSessionBinding（跨租户隔离）。不存在返回 null。 */
export async function getSessionBindingById(
  tenantId: string,
  bindingId: string,
): Promise<V11RuntimeSessionBinding | null> {
  const [row] = await db
    .select()
    .from(v11RuntimeSessionBinding)
    .where(
      and(
        eq(v11RuntimeSessionBinding.tenantId, tenantId),
        eq(v11RuntimeSessionBinding.id, bindingId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 按 runtimeRevisionId + externalSessionRef 获取 RuntimeSessionBinding。
 *
 * 不做租户隔离（外部 Session Ref 来自 Runtime 响应，调度器已通过租户校验）。
 * 不存在返回 null。
 */
export async function getSessionBindingByExternalRef(
  runtimeRevisionId: string,
  externalSessionRef: string,
): Promise<V11RuntimeSessionBinding | null> {
  const [row] = await db
    .select()
    .from(v11RuntimeSessionBinding)
    .where(
      and(
        eq(v11RuntimeSessionBinding.runtimeRevisionId, runtimeRevisionId),
        eq(v11RuntimeSessionBinding.externalSessionRef, externalSessionRef),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 列出 Thread 的所有 RuntimeSessionBinding（按 createdAt 升序，跨租户隔离）。 */
export async function getSessionBindingsByThread(
  tenantId: string,
  threadId: string,
): Promise<V11RuntimeSessionBinding[]> {
  return db
    .select()
    .from(v11RuntimeSessionBinding)
    .where(
      and(
        eq(v11RuntimeSessionBinding.tenantId, tenantId),
        eq(v11RuntimeSessionBinding.threadId, threadId),
      ),
    );
}

/**
 * 更新最近使用时间（调用 Runtime 后刷新，用于心跳/活动追踪）。
 *
 * 轻量更新，不在事务内；不存在时静默返回 null。
 */
export async function updateLastUsedAt(
  bindingId: string,
  at: Date = new Date(),
): Promise<V11RuntimeSessionBinding | null> {
  await db
    .update(v11RuntimeSessionBinding)
    .set({ lastUsedAt: at })
    .where(eq(v11RuntimeSessionBinding.id, bindingId));

  const [row] = await db
    .select()
    .from(v11RuntimeSessionBinding)
    .where(eq(v11RuntimeSessionBinding.id, bindingId))
    .limit(1);
  return row ?? null;
}

/**
 * 关闭 RuntimeSessionBinding（bindingState active → closed）。
 *
 * 仅 active 状态可关闭；closed/lost 静默返回当前行（幂等）。
 * 不实际调用 Runtime close API（由调用方决定是否请求 Runtime 关闭）。
 *
 * @throws RuntimeSessionBindingNotFoundError 绑定不存在
 */
export async function closeSessionBinding(bindingId: string): Promise<V11RuntimeSessionBinding> {
  const [current] = await db
    .select()
    .from(v11RuntimeSessionBinding)
    .where(eq(v11RuntimeSessionBinding.id, bindingId))
    .limit(1);
  if (!current) {
    throw new RuntimeSessionBindingNotFoundError(bindingId);
  }

  // 已是终态（closed/lost）幂等返回
  if (current.bindingState !== "active") {
    return current;
  }

  const now = new Date();
  await db
    .update(v11RuntimeSessionBinding)
    .set({ bindingState: "closed", closedAt: now, lastUsedAt: now })
    .where(eq(v11RuntimeSessionBinding.id, bindingId));

  const [updated] = await db
    .select()
    .from(v11RuntimeSessionBinding)
    .where(eq(v11RuntimeSessionBinding.id, bindingId))
    .limit(1);
  if (!updated) {
    throw new Error(`closeSessionBinding: RuntimeSessionBinding 行未找到（id=${bindingId}）`);
  }
  return updated;
}

/**
 * 标记 RuntimeSessionBinding 为 lost（bindingState active → lost）。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §6.11（bindingState 含 lost 终态）、
 *         §13（Worker 失联恢复：原 Runtime 会话失联，平台标记 lost 并创建新 Attempt + 新 SessionBinding）。
 *
 * 仅 active 状态可标记 lost；closed/lost 静默返回当前行（幂等）。
 * 与 closeSessionBinding 区别：lost 表示 Runtime 侧异常失联（非正常关闭），
 * 用于诊断和清理；closed 表示正常关闭。
 *
 * @throws RuntimeSessionBindingNotFoundError 绑定不存在
 */
export async function markSessionBindingLost(bindingId: string): Promise<V11RuntimeSessionBinding> {
  const [current] = await db
    .select()
    .from(v11RuntimeSessionBinding)
    .where(eq(v11RuntimeSessionBinding.id, bindingId))
    .limit(1);
  if (!current) {
    throw new RuntimeSessionBindingNotFoundError(bindingId);
  }

  // 已是终态（closed/lost）幂等返回
  if (current.bindingState !== "active") {
    return current;
  }

  const now = new Date();
  await db
    .update(v11RuntimeSessionBinding)
    .set({ bindingState: "lost", closedAt: now, lastUsedAt: now })
    .where(eq(v11RuntimeSessionBinding.id, bindingId));

  const [updated] = await db
    .select()
    .from(v11RuntimeSessionBinding)
    .where(eq(v11RuntimeSessionBinding.id, bindingId))
    .limit(1);
  if (!updated) {
    throw new Error(`markSessionBindingLost: RuntimeSessionBinding 行未找到（id=${bindingId}）`);
  }
  return updated;
}
