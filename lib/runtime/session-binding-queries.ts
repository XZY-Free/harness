/**
 * RuntimeSessionBinding 仓储（S05-C02）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （RuntimeSessionBinding L506-508）
 * - docs/architecture/agent-control-plane.md §6（Invocation 生命周期）
 * - docs/architecture/runtime-control-plane.md S05-C02
 *
 * 职责：
 * - createSessionBinding：INSERT RuntimeSessionBinding（externalSessionRef 来自 Runtime 响应）。
 * - getSessionBindingById / getSessionBindingByExternalRef / getSessionBindingsByThread：查询。
 * - findReusableSessionBinding：按 专题01 冻结架构匹配维度（Tenant+Thread+RuntimeRevision）
 *   查找可复用的 active Session（Turn completed 不是关闭条件，06 §3）。
 * - updateLastUsedAt：调用 Runtime 后刷新最近使用时间。
 * - closeSessionBinding：显式关闭（Thread 关闭/删除、用户 reset、continuity policy 不允许、
 *   管理操作）；平台仅标记 bindingState=closed。Turn 终态不调用。
 *
 * 关键约束：
 * - threadId/jobId 恰有一个非空（应用层校验，DB 不加 CHECK）。
 * - externalSessionRef 由 Runtime 颁发，平台仅持久化引用，不解析其内容。
 * - UNIQUE(runtimeRevisionId, externalSessionRef)：同一 RuntimeRevision 下外部会话引用唯一。
 * - 外部 Session 不取代 Thread，仅作为 Runtime 侧执行上下文锚点。
 */
import { db } from "@/lib/db/client";
import type { RuntimeSessionBinding } from "@/lib/persistence/schema/executions";
import { runtimeSessionBindingTable } from "@/lib/persistence/schema/executions";
import {
  RuntimeSessionBindingConflictError,
  RuntimeSessionBindingNotFoundError,
} from "@/lib/runtime/errors";
import { and, desc, eq } from "drizzle-orm";

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
): Promise<RuntimeSessionBinding> {
  // 1. 校验 threadId/jobId 恰有一个非空
  const hasThread = params.threadId !== null && params.threadId !== undefined;
  const hasJob = params.jobId !== null && params.jobId !== undefined;
  if (hasThread === hasJob) {
    throw new Error("createSessionBinding: threadId/jobId 必须恰有一个非空");
  }

  // 2. 检查同 runtimeRevisionId+externalSessionRef 是否已存在
  const [existing] = await db
    .select({ id: runtimeSessionBindingTable.id })
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.runtimeRevisionId, params.runtimeRevisionId),
        eq(runtimeSessionBindingTable.externalSessionRef, params.externalSessionRef),
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
  await db.insert(runtimeSessionBindingTable).values({
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
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.runtimeRevisionId, params.runtimeRevisionId),
        eq(runtimeSessionBindingTable.externalSessionRef, params.externalSessionRef),
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
): Promise<RuntimeSessionBinding | null> {
  const [row] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.id, bindingId),
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
): Promise<RuntimeSessionBinding | null> {
  const [row] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.runtimeRevisionId, runtimeRevisionId),
        eq(runtimeSessionBindingTable.externalSessionRef, externalSessionRef),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 列出 Thread 的所有 RuntimeSessionBinding（按 createdAt 升序，跨租户隔离）。 */
export async function getSessionBindingsByThread(
  tenantId: string,
  threadId: string,
): Promise<RuntimeSessionBinding[]> {
  return db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.threadId, threadId),
      ),
    );
}

/**
 * 查找可复用的 active RuntimeSessionBinding（专题01 冻结架构匹配维度）。
 *
 * 匹配维度：tenantId + threadId + runtimeRevisionId 全等
 * （RuntimeSessionBinding 只绑定 Harness Runtime，不再含 Agent 维度）。
 * 只返回 bindingState=active 的最近一条（createdAt 降序）；
 * closed/lost 不复用（06 §3 关闭条件）。
 */
export async function findReusableSessionBinding(params: {
  tenantId: string;
  threadId: string;
  runtimeRevisionId: string;
}): Promise<RuntimeSessionBinding | null> {
  const [row] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, params.tenantId),
        eq(runtimeSessionBindingTable.threadId, params.threadId),
        eq(runtimeSessionBindingTable.runtimeRevisionId, params.runtimeRevisionId),
        eq(runtimeSessionBindingTable.bindingState, "active"),
      ),
    )
    .orderBy(desc(runtimeSessionBindingTable.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * 更新最近使用时间（调用 Runtime 后刷新，用于心跳/活动追踪）。
 *
 * 轻量更新，不在事务内；不存在时静默返回 null。
 */
export async function updateLastUsedAt(
  bindingId: string,
  at: Date = new Date(),
): Promise<RuntimeSessionBinding | null> {
  await db
    .update(runtimeSessionBindingTable)
    .set({ lastUsedAt: at })
    .where(eq(runtimeSessionBindingTable.id, bindingId));

  const [row] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, bindingId))
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
export async function closeSessionBinding(bindingId: string): Promise<RuntimeSessionBinding> {
  const [current] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, bindingId))
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
    .update(runtimeSessionBindingTable)
    .set({ bindingState: "closed", closedAt: now, lastUsedAt: now })
    .where(eq(runtimeSessionBindingTable.id, bindingId));

  const [updated] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, bindingId))
    .limit(1);
  if (!updated) {
    throw new Error(`closeSessionBinding: RuntimeSessionBinding 行未找到（id=${bindingId}）`);
  }
  return updated;
}

/** 事务句柄类型（caller-owned session 版本使用）。 */
type Session = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 标记 RuntimeSessionBinding 为 lost（bindingState active → lost）— caller-owned session 版本。
 *
 * 事实源：docs/V12/01/SnowHarness_九项问题最终代码收口方案_2026-08-27/02-Recovery与Turn终态事务一致性.md §三。
 *
 * 唯一 SQL 实现：行锁（FOR UPDATE）+ active → lost + closedAt/lastUsedAt；closed/lost 幂等。
 * markInvocationLost 等组合事务必须使用本版本，保证 Invocation/Session/Turn/Event 同事务。
 *
 * @throws RuntimeSessionBindingNotFoundError 绑定不存在
 */
export async function markSessionBindingLostInSession(
  session: Session,
  bindingId: string,
): Promise<RuntimeSessionBinding> {
  const [current] = await session
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, bindingId))
    .for("update")
    .limit(1);
  if (!current) {
    throw new RuntimeSessionBindingNotFoundError(bindingId);
  }

  // 已是终态（closed/lost）幂等返回
  if (current.bindingState !== "active") {
    return current;
  }

  const now = new Date();
  await session
    .update(runtimeSessionBindingTable)
    .set({ bindingState: "lost", closedAt: now, lastUsedAt: now })
    .where(eq(runtimeSessionBindingTable.id, bindingId));

  const [updated] = await session
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, bindingId))
    .limit(1);
  if (!updated) {
    throw new Error(
      `markSessionBindingLostInSession: RuntimeSessionBinding 行未找到（id=${bindingId}）`,
    );
  }
  return updated;
}

/**
 * 标记 RuntimeSessionBinding 为 lost（bindingState active → lost）— 独立事务包装。
 *
 * 事实源：docs/architecture/persistence.md （bindingState 含 lost 终态）、
 * §13（Worker 失联恢复：原 Runtime 会话失联，平台标记 lost 并创建新 Attempt + 新 SessionBinding）。
 *
 * 与 closeSessionBinding 区别：lost 表示 Runtime 侧异常失联（非正常关闭），
 * 用于诊断和清理；closed 表示正常关闭。SQL 唯一实现在 markSessionBindingLostInSession。
 *
 * @throws RuntimeSessionBindingNotFoundError 绑定不存在
 */
export async function markSessionBindingLost(bindingId: string): Promise<RuntimeSessionBinding> {
  return db.transaction(async (tx) => markSessionBindingLostInSession(tx, bindingId));
}
