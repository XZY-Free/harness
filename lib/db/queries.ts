import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { approvalConfig, dbConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { encryptCicdToken } from "@/lib/runtime/secret-crypto";
// 12-事件总线广播——appendThreadEvent 成功后广播到进程内 hub，供 SSE 端点即时推送。
// 放 queries.ts，因 appendThreadEvent 在此文件；thread-events-bus 无其他依赖，不引入循环。
import { broadcastThreadEvent } from "@/lib/runtime/thread-events-bus";
import { escapeLikeWildcards } from "@/lib/utils";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { db } from "./client";

/**
 * 事务客户端类型(db 或 db.transaction 的 tx),供函数可选接入事务。
 * 事务外的调用方不传 tx,函数内用 db;事务内传 tx,写入加入同一原子边界。
 */
export type DbTxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];
import {
  type AdminAuditAction,
  type AdminAuditLog,
  type AdminAuditOutcome,
  type ApprovalRequestStatus,
  type ApprovalScope,
  type ContextSnapshot,
  type ContextSummary,
  type ContextSummaryType,
  type CustomTool,
  type DBMessage,
  type Deployment,
  type DeploymentStatus,
  type GitCheckpoint,
  type McpServerConfig,
  type MemoryConfidence,
  type MemoryEmbedding,
  type MemoryEntry,
  type MemoryKind,
  type MemoryProvenanceEntry,
  type MemoryScope,
  type MemoryStatus,
  type PermissionDecision,
  type PermissionScope,
  type SecretMount,
  type SecretMountScope,
  type SecretMountStatus,
  type Skill,
  type SkillSource,
  type SkillStatus,
  type SkillSyncMapping,
  type SkillSyncState,
  type SkillVersion,
  type SkillVersionStatus,
  type ThreadEvent,
  type ThreadEventType,
  type ThreadPlan,
  type ThreadPlanItem,
  type ThreadPlanItemStatus,
  type ThreadStatus,
  type ToolApprovalRequest,
  type ToolPermissionRule,
  type ToolRun,
  type ToolRunStatus,
  adminAuditLog,
  auditFailureLog,
  contextSnapshot,
  contextSummary,
  customTool,
  deployment,
  gitCheckpoint,
  mcpServerConfig,
  memoryEmbedding,
  memoryEntry,
  message,
  messageTypeForRole,
  policyConfig,
  policyConfigHistory,
  secretMount,
  skill,
  skillSyncMapping,
  skillVersion,
  thread,
  threadEvent,
  threadPlan,
  threadPlanItem,
  toolApprovalRequest,
  toolPermissionRule,
  toolRun,
  user,
} from "./schema";
import {
  contextSnapshotChecksumsSchema,
  contextSnapshotLayersSchema,
  contextSnapshotSkillLoadEvidenceSchema,
  contextSnapshotSkillResolverInputSchema,
  contextSnapshotSkillResolverOutputSchema,
  customToolExecutorConfigSchema,
  customToolInputSchemaSchema,
  memoryProvenanceSchema,
  threadPinnedFactsSchema,
  toolRunInputSchema,
  toolRunOutputSchema,
  validateJsonColumn,
} from "./schemas/json-columns";

// ─── Thread Queries ──────────────────────────────────────────

/** 取 thread（含软删）。仅供 purge/存在性判断等需看软删的场景；HTTP 入口与内部调用应用 getThreadById。 */
export async function getThreadByIdIncludingDeleted(id: string) {
  const [row] = await db.select().from(thread).where(eq(thread.id, id)).limit(1);
  return row ?? null;
}

/** 取未软删 thread。HTTP 入口与内部调用默认口径：软删 thread 不可见（与 getThreadByIdForUser/listThreadsForUser 一致）。 */
export async function getThreadById(id: string) {
  const [row] = await db
    .select()
    .from(thread)
    .where(and(eq(thread.id, id), isNull(thread.deletedAt)))
    .limit(1);
  return row ?? null;
}

// ─── Owner-scoped Thread Queries () ────────────────
// HTTP 入口在读写 thread 前必须用这些带 userId 归属的 helper，避免裸 threadId
// 越权。内部 tool runtime 仍只传 threadId（只经已授权 chat route 启动）。

/** 取属于指定用户且未软删的 thread；不属于或已软删则返回 null（HTTP 入口据此返回 404）。
 * C-3：与 listThreadsForUser / getLatestThreadForUser 口径一致，软删 thread 内容不可访问。 */
export async function getThreadByIdForUser(id: string, userId: string) {
  const [row] = await db
    .select()
    .from(thread)
    .where(and(eq(thread.id, id), eq(thread.userId, userId), isNull(thread.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** requireThreadForUser：语义同 getThreadByIdForUser，命名表达「入口校验」意图。 */
export async function requireThreadForUser(id: string, userId: string) {
  return getThreadByIdForUser(id, userId);
}

/** 取用户最近一个 thread（首页按用户恢复会话用）；无则 null。B-8: 按 updatedAt desc。
 * C-3: 过滤掉软删（deletedAt 非 null）的会话——与 listThreadsForUser 口径一致，
 * 避免软删会话在首页恢复入口复活。 */
export async function getLatestThreadForUser(userId: string) {
  const [row] = await db
    .select()
    .from(thread)
    .where(and(eq(thread.userId, userId), isNull(thread.deletedAt)))
    .orderBy(desc(thread.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * 列出用户会话（C-3 过滤软删 + C-8 最近消息预览冗余列 + C-9 游标分页 + E-2 后端搜索 + E-6 lastMessageId）。
 *
 * - C-3: deletedAt IS NULL 过滤软删会话（替代原 status=cancelled 降级）。
 * - C-8: lastMessagePreview 冗余列（saveMessages 时更新，免 join）。
 * - C-9: 复合游标 (updatedAt, id) 分页 —— id tie-breaker 防同秒 updatedAt 漏/重（与 getMessagesByThreadId 同款）。
 * - E-2: search 非空时按 title / lastMessagePreview 模糊匹配（LIKE），覆盖 >50 条未加载的旧会话。
 * - E-5: pinnedAt 非 null 置顶组永远在最前；置顶操作 togglePinThread 会刷 updatedAt，故置顶内部按 updatedAt desc 即兼顾「置顶瞬间排前 + 置顶后按活动」。
 * - E-6: lastMessageId 冗余列（消息级未读判定用）。
 */
export async function listThreadsForUser(
  userId: string,
  opts: { limit?: number; before?: { updatedAt: Date; id: string }; search?: string } = {},
) {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const conds = [eq(thread.userId, userId), isNull(thread.deletedAt)];
  if (opts.before) {
    // C-9: 复合游标 (updatedAt, id) —— updatedAt 相同时按 id desc 续传，防同秒并列漏/重。
    const beforeCond = or(
      lt(thread.updatedAt, opts.before.updatedAt),
      and(eq(thread.updatedAt, opts.before.updatedAt), lt(thread.id, opts.before.id)),
    );
    if (beforeCond) conds.push(beforeCond);
  }
  // E-2: 后端模糊搜索（title 或 lastMessagePreview 包含关键词）
  // 审计修复 M3：转义 SQL LIKE 通配符（原代码未转义 % 和 _，用户搜索 "%" 会匹配全部行，
  // 可探测数据形状并在大表上触发全表扫描）。
  if (opts.search?.trim()) {
    const escaped = escapeLikeWildcards(opts.search.trim());
    const kw = `%${escaped}%`;
    const searchCond = or(like(thread.title, kw), like(thread.lastMessagePreview, kw));
    if (searchCond) conds.push(searchCond);
  }
  return db
    .select({
      id: thread.id,
      title: thread.title,
      status: thread.status,
      model: thread.model,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      pinnedAt: thread.pinnedAt,
      previewUrl: thread.previewUrl,
      lastMessagePreview: thread.lastMessagePreview,
      lastMessageId: thread.lastMessageId,
    })
    .from(thread)
    .where(and(...conds))
    .orderBy(desc(thread.pinnedAt), desc(thread.updatedAt), desc(thread.id))
    .limit(limit);
}

/**
 * B-6: 跨实例状态通道——DB 增量轮询。
 * 返回 updatedAt > since 的该用户 thread 状态变更（updateThreadStatus 每次变更同步刷 updatedAt，
 * 故跨实例的他实例 run 状态变化也能被各实例 SSE 端点轮询感知）。用于 SSE 端点补推他实例变更。
 */
export async function listThreadStatusChanges(userId: string, sinceUpdatedAt: Date) {
  return db
    .select({
      threadId: thread.id,
      status: thread.status,
      updatedAt: thread.updatedAt,
    })
    .from(thread)
    .where(
      and(
        eq(thread.userId, userId),
        isNull(thread.deletedAt),
        gt(thread.updatedAt, sinceUpdatedAt),
      ),
    )
    .orderBy(asc(thread.updatedAt))
    .limit(200);
}

/**
 * 取 thread 消息，但先校验 thread 归属当前用户。
 * foreign thread → null（调用方据此 404，不泄露消息）。
 */
export async function getMessagesByThreadIdForUser(
  threadId: string,
  userId: string,
): Promise<DBMessage[] | null> {
  const owned = await getThreadByIdForUser(threadId, userId);
  if (!owned) return null;
  return getMessagesByThreadId(threadId);
}

export async function saveThread({
  id,
  userId,
  title,
  model,
}: {
  id: string;
  userId: string;
  title: string;
  model?: string | null;
}) {
  // B-8: updatedAt 与 createdAt 同步初始化
  const now = new Date();
  // MySQL 无 onConflictDoNothing：用 INSERT IGNORE（drizzle .ignore()）做幂等写入
  await db
    .insert(thread)
    .ignore()
    .values({ id, userId, title, model: model ?? null, createdAt: now, updatedAt: now });
}

/** B-8: 刷新 thread 最后活动时间（发消息 / 状态变更 / 模型变更等场景调用）。 */
export async function touchThread(threadId: string) {
  await db.update(thread).set({ updatedAt: new Date() }).where(eq(thread.id, threadId));
}

/** C-2: 重命名会话标题。 */
export async function updateThreadTitle(threadId: string, title: string) {
  await db.update(thread).set({ title, updatedAt: new Date() }).where(eq(thread.id, threadId));
}

/** C-1: LLM 生成标题后更新 title（+ updatedAt）。C-1 重构后删 titleUpdatedAt 防抖守门，
 * 自动生成（chat route 首条并行）与手动「重新生成标题」均走此函数，语义同 updateThreadTitle。 */
export async function updateGeneratedTitle(threadId: string, title: string) {
  await db.update(thread).set({ title, updatedAt: new Date() }).where(eq(thread.id, threadId));
}

/** E-5: 切换置顶（有 pinnedAt 则清除，无则设 NOW()）。返回是否已置顶。 */
export async function togglePinThread(threadId: string) {
  const [row] = await db
    .select({ pinnedAt: thread.pinnedAt })
    .from(thread)
    .where(eq(thread.id, threadId))
    .limit(1);
  const pinnedAt = row?.pinnedAt ? null : new Date();
  await db.update(thread).set({ pinnedAt, updatedAt: new Date() }).where(eq(thread.id, threadId));
  return pinnedAt !== null;
}

/** C-3: 软删除会话（标记 deletedAt，列表查询过滤 deletedAt IS NULL）。 */
export async function softDeleteThread(threadId: string) {
  await db
    .update(thread)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(thread.id, threadId));
}

/**
 * thread 物理删除时需清理的全部子表,按外键依赖顺序(先删引用方,最后删 thread 主记录)。
 *
 * retention 明细清理与彻底物理删除共用此清单,避免两套删表逻辑漏表。
 * 子表均用 threadId 关联,故以 {table, column} 显式标注列名。
 */
const THREAD_CHILD_TABLES: ReadonlyArray<{
  table: MySqlTable;
  column: AnyColumn;
}> = [
  { table: toolApprovalRequest, column: toolApprovalRequest.threadId },
  { table: gitCheckpoint, column: gitCheckpoint.threadId },
  { table: contextSnapshot, column: contextSnapshot.threadId },
  { table: contextSummary, column: contextSummary.threadId },
  { table: toolRun, column: toolRun.threadId },
  { table: threadEvent, column: threadEvent.threadId },
  { table: threadPlanItem, column: threadPlanItem.threadId },
  { table: threadPlan, column: threadPlan.threadId },
  { table: message, column: message.threadId },
  // P0-1: deployment.threadId 是 DB 级 FK(NO ACTION),漏删会触发 FK 违约导致整个物理删除事务回滚。
  { table: deployment, column: deployment.threadId },
  // P0-1: auditFailureLog.threadId 无 DB FK(逻辑外键),漏删会留孤儿行,一并清理。
  { table: auditFailureLog, column: auditFailureLog.threadId },
  // ：V9 浏览器表（browserSession/browserDownload/userBrowserProfile）
  // 已由 migration 0059 删除，物理删除级联清单不再包含它们。
];

/**
 * 物理删除 thread + 全部子表数据。
 *
 * 不依赖 FK onDelete cascade——schema 子表 threadId 为逻辑外键(未建 DB 外键约束),
 * 无 RESTRICT 阻塞,应用层级联删即可;ALTER 现有表加 FK 有锁风险且与软删策略冲突,故不走 DB cascade。
 *
 * 可靠性保证(修复原实现的死代码 + 吞错 + 非原子三问题):
 * - 事务包裹:全部删除原子完成,中途任一语句失败则整体回滚,不留删一半的孤儿数据
 * - 不吞错误:删除失败让异常冒泡(原 .catch(()=>{}) 会静默吞错,导致部分子表残留)
 * - 按依赖顺序:先删全部子表,最后删 thread 主记录
 *
 * 软删除(deletedAt)保留主记录;本函数彻底物理删除,仅用于:
 * ① admin 显式彻底删除入口;② retention 软删超期后的主记录物理清理(可配,默认关)。
 */
export async function deleteThreadRecursive(threadId: string): Promise<void> {
  await db.transaction(async (tx) => {
    for (const { table, column } of THREAD_CHILD_TABLES) {
      await tx.delete(table).where(eq(column, threadId));
    }
    await tx.delete(thread).where(eq(thread.id, threadId));
  });
}

/**
 * 更新 thread status。
 *
 * : 可选 `expectedFrom` 做 CAS——SQL 加 `WHERE status = expectedFrom`,
 * 仅当当前 status 匹配预期时才更新。用于 finalize(idle)/cancel(cancelled)/markFailed(failed)
 * 等终态写入,防并发互相覆盖(原无条件 UPDATE 是 last-write-wins)。
 * 未传 expectedFrom 时退化为无条件更新(兼容非竞态路径)。
 * @returns 是否实际更新了行(expectedFrom 不匹配时返回 false)
 */
export async function updateThreadStatus(
  threadId: string,
  status: ThreadStatus,
  expectedFrom?: ThreadStatus | ThreadStatus[],
): Promise<boolean> {
  const conds = [eq(thread.id, threadId)];
  if (expectedFrom) {
    const froms = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];
    conds.push(inArray(thread.status, froms));
  }
  const result = await db
    .update(thread)
    .set({ status, updatedAt: new Date() })
    .where(and(...conds));
  return (result as unknown as { affectedRows?: number }).affectedRows !== 0;
}

/**
 * E-7: 累加 thread token 用量（run 级 onFinish 调用，跨 run 持续累计）。
 * 原子累加，fail-open（调用方 catch）。冗余列用于 header 免 SUM 事件流展示。
 */
export async function incrementThreadTokens(
  threadId: string,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number },
) {
  await db
    .update(thread)
    .set({
      promptTokens: sql`${thread.promptTokens} + ${usage.inputTokens}`,
      completionTokens: sql`${thread.completionTokens} + ${usage.outputTokens}`,
      totalTokens: sql`${thread.totalTokens} + ${usage.totalTokens}`,
    })
    .where(eq(thread.id, threadId));
}

export async function updateThreadModel(threadId: string, model: string) {
  // B-8: 模型变更同步刷新 updatedAt
  await db.update(thread).set({ model, updatedAt: new Date() }).where(eq(thread.id, threadId));
}

export async function updateThreadPreviewUrl(threadId: string, previewUrl: string | null) {
  // B-8: 预览变更同步刷新 updatedAt
  await db.update(thread).set({ previewUrl, updatedAt: new Date() }).where(eq(thread.id, threadId));
}

/**
 * P0 修复（03 Context pinned facts 持久化）：更新 thread 的 pinnedFacts。
 *
 * pinnedFacts 是用户明确要求保留的事实（protected 集合数据源），原进程内 Map 重启即失。
 * 落 DB json 列持久化。null=清空。同步刷新 updatedAt。
 */
export async function updateThreadPinnedFacts(threadId: string, pinnedFacts: string[] | null) {
  await db
    .update(thread)
    .set({ pinnedFacts, updatedAt: new Date() })
    .where(eq(thread.id, threadId));
}

/**
 * pinned facts 原子化读-改-写。
 *
 * 原实现 addPinnedFact/removePinnedFact 先 getPinnedFacts（读）再 updateThreadPinnedFacts（写），
 * 两次独立查询非原子，并发 add 会丢失写入。本函数在单事务内 `SELECT ... FOR UPDATE` 锁行 +
 * 调用 mutator 计算新值 + UPDATE，保证并发安全。mutator 接收当前数组返回新数组（null=清空）。
 */
export async function mutateThreadPinnedFacts(
  threadId: string,
  mutator: (current: string[]) => string[] | null,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ pinnedFacts: thread.pinnedFacts })
      .from(thread)
      .where(eq(thread.id, threadId))
      .for("update");
    const current = Array.isArray(row?.pinnedFacts) ? (row.pinnedFacts as string[]) : [];
    const next = mutator(current);
    // json 列 zod 校验（fail-closed，mutator 返回非法结构抛错不落库）
    validateJsonColumn(next, threadPinnedFactsSchema, "pinnedFacts");
    await tx
      .update(thread)
      .set({ pinnedFacts: next, updatedAt: new Date() })
      .where(eq(thread.id, threadId));
    return next ?? [];
  });
}

/**
 * 更新 thread 的 reviewState。
 *
 * QA gate 连续失败超上限时,转人工审核(reviewState="needs_human_review"),
 * 停止 agent 自动重试,防烧 token。同步刷新 updatedAt。
 */
export async function updateThreadReviewState(threadId: string, reviewState: string | null) {
  await db
    .update(thread)
    .set({ reviewState, updatedAt: new Date() })
    .where(eq(thread.id, threadId));
}

/**
 * 更新 thread 的 per-thread CI/CD API token。
 * 加密存储（AES-256-GCM）；master key 未配置时 fail-closed 拒绝明文写入。
 * null 表示清除（回退到全局 cicdApiToken）。
 */
export async function updateThreadCicdToken(threadId: string, cicdApiToken: string | null) {
  let stored: string | null = null;
  if (cicdApiToken !== null) {
    stored = encryptCicdToken(cicdApiToken);
  }
  await db
    .update(thread)
    .set({ cicdApiToken: stored, updatedAt: new Date() })
    .where(eq(thread.id, threadId));
}

// ─── Message Queries ─────────────────────────────────────────

/**
 * 取 thread 的消息(按 createdAt, id 升序)。
 *
 * : 加 limit + before 游标,防长会话全量加载 OOM。默认 500 条(覆盖绝大多数会话),
 * 上限 5000;export 等需全量的场景显式传大 limit。before 游标用于向前翻页(取游标之前的消息)。
 *
 * P0 修复（08 DB ）：orderBy 加 id 作 tie-breaker,防同毫秒消息乱序。
 */
export async function getMessagesByThreadId(
  threadId: string,
  opts?: { limit?: number; before?: { createdAt: Date; id: string } },
): Promise<DBMessage[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 5000);
  const conds = [eq(message.threadId, threadId)];
  if (opts?.before) {
    const cursorCondition = or(
      lt(message.createdAt, opts.before.createdAt),
      and(eq(message.createdAt, opts.before.createdAt), lt(message.id, opts.before.id)),
    );
    if (cursorCondition) conds.push(cursorCondition);
  }
  return db
    .select()
    .from(message)
    .where(and(...conds))
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(limit);
}

export async function saveMessages(
  rows: Array<{
    id: string;
    threadId: string;
    role: string;
    parts: unknown;
    type?: string | null;
    runId?: string | null;
  }>,
) {
  if (rows.length === 0) {
    return;
  }
  // json 列轻量校验。parts 须为数组且每项有 type 字符串（防脏数据写入）。
  // 校验失败 fail-open：过滤非法 part 后继续写入（不阻断 chat）。
  const validatedRows = rows.map((r) => {
    if (!Array.isArray(r.parts)) return r;
    const validParts = r.parts.filter(
      (p) => p && typeof p === "object" && typeof (p as { type?: unknown }).type === "string",
    );
    return { ...r, parts: validParts.length > 0 ? validParts : r.parts };
  });
  // IGNORE 批量写入，重复消息 id 自动跳过；type 缺省按 role 推导，保证分层非空
  await db
    .insert(message)
    .ignore()
    .values(
      validatedRows.map((r) => ({
        id: r.id,
        threadId: r.threadId,
        role: r.role,
        parts: r.parts,
        type: r.type ?? messageTypeForRole(r.role),
        runId: r.runId ?? null,
        createdAt: new Date(),
      })),
    );
  // C-8 + E-6: 冗余更新 thread.lastMessagePreview（截断 60 字）+ lastMessageId（消息级未读判定）
  const last = rows[rows.length - 1];
  if (last) {
    const preview = extractTextFromParts(last.parts).slice(0, 60) || null;
    await db
      .update(thread)
      .set({ lastMessagePreview: preview, lastMessageId: last.id, updatedAt: new Date() })
      .where(eq(thread.id, last.threadId));
  }
}

/**
 * B-3: part 级增量落库——按主键 id upsert message.parts。
 * onStepFinish 每个 step 边界调用（已组装的 responseMessage.parts 覆盖写回），
 * onFinish 收尾调用（补中断瞬间的 partial part）。ON DUPLICATE KEY UPDATE parts，
 * 多次写同 id 最后一次赢，天然幂等。替代 saveMessages 的 INSERT IGNORE（IGNORE 遇同 id
 * 不更新，无法捕获最终 partial）。user 消息仍用 saveMessages（route 层一次性写入）。
 */
export async function upsertMessageParts(
  rows: Array<{
    id: string;
    threadId: string;
    role: string;
    parts: unknown;
    type?: string | null;
    runId?: string | null;
  }>,
) {
  if (rows.length === 0) return;
  await db
    .insert(message)
    .values(
      rows.map((r) => ({
        id: r.id,
        threadId: r.threadId,
        role: r.role,
        parts: r.parts,
        type: r.type ?? messageTypeForRole(r.role),
        runId: r.runId ?? null,
        createdAt: new Date(),
      })),
    )
    .onDuplicateKeyUpdate({
      // runId 纳入覆盖：重试换 runId 时，同 message id 的旧 runId 要被新 runId 覆盖，
      // 保证 runId 始终指向最后一次产出该消息的 run（B-3 隔离语义）。
      set: { parts: sql`VALUES(parts)`, type: sql`VALUES(type)`, runId: sql`VALUES(runId)` },
    });
  // C-8 + E-6: 同步冗余更新 thread.lastMessagePreview + lastMessageId
  const last = rows[rows.length - 1];
  if (last) {
    const preview = extractTextFromParts(last.parts).slice(0, 60) || null;
    await db
      .update(thread)
      .set({ lastMessagePreview: preview, lastMessageId: last.id, updatedAt: new Date() })
      .where(eq(thread.id, last.threadId));
  }
}

/** 从 message parts（json 数组）提取预览文本：优先 text part 拼接；
 * 无 text part（纯工具调用 / 纯附件收尾）时取首个工具或附件 part 的语义占位，
 * 避免列表预览为空导致用户无法区分会话（C-8）。 */
function extractTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const arr = parts as Array<{ type?: string; text?: string }>;
  const text = arr
    .filter((p) => p?.type === "text")
    .map((p) => p.text ?? "")
    .join("");
  if (text.trim()) return text;
  // 无 text：取首个工具 / 附件 part 的占位（reasoning 是内部推理，不作为预览）
  const placeholder = arr.find((p) => {
    const t = p?.type ?? "";
    return t !== "text" && t !== "reasoning" && (t.includes("tool") || t.includes("attachment"));
  });
  if (placeholder?.type?.includes("attachment")) return "附件";
  if (placeholder) return "工具调用";
  return "";
}

/**
 * 删除指定消息及其之后的所有消息（按 createdAt >= 目标消息的 createdAt）。
 * 用于「编辑最后一条 user 消息重新生成」场景：截断 DB 与前端 setMessages(truncated) 对齐，
 * 避免旧消息残留导致刷新后出现重复消息。
 *
 * 通过先查出目标消息的 createdAt，再删除同 thread 内 createdAt >= 该时间的所有消息实现。
 * @returns 被删除的行数
 */
export async function deleteMessagesFromId(threadId: string, messageId: string): Promise<number> {
  const [target] = await db
    .select({ createdAt: message.createdAt, id: message.id })
    .from(message)
    .where(and(eq(message.id, messageId), eq(message.threadId, threadId)));
  if (!target) return 0;
  // (createdAt, id) 复合比较，避免同毫秒消息误删（原 createdAt >= 删同秒 id 更大的）。
  const result = await db
    .delete(message)
    .where(
      and(
        eq(message.threadId, threadId),
        or(
          gt(message.createdAt, target.createdAt),
          and(eq(message.createdAt, target.createdAt), gte(message.id, target.id)),
        ),
      ),
    );
  return result[0].affectedRows ?? 0;
}

// ─── Thread Event Queries (append-only 事件流) ───────

/**
 * 分配下一个 sequence 值（）。
 * 取当前 thread 最大 sequence + 1；无历史记录时从 1 开始。
 * 原子性由 appendThreadEvent 的 unique 冲突重试保证（非此函数）。
 */
async function nextSequence(threadId: string): Promise<number> {
  const [row] = await db
    .select({ value: max(threadEvent.sequence) })
    .from(threadEvent)
    .where(eq(threadEvent.threadId, threadId));
  return (row?.value ?? 0) + 1;
}

/**
 * 追加一条 thread 事件。
 *
 * @param threadId - 所属 thread
 * @param type - 事件类型（必须来自 THREAD_EVENT_TYPES 权威表）
 * @param payload - 事件负载（JSON 可序列化对象）
 */
export async function appendThreadEvent(
  threadId: string,
  type: ThreadEventType,
  payload: Record<string, unknown>,
  /** 归属历史 run（nullable（历史事件和纯 thread 管理事件可空））。 */
  runId?: string | null,
): Promise<ThreadEvent> {
  // P2-11: 事务内 FOR UPDATE thread 行串行化同 thread 事件写入,原子取 seq + insert,
  // 防 nextSequence MAX+1 在多实例并发下撞 unique(threadId, sequence) 耗尽 5 次重试。
  return db.transaction(async (tx) => {
    await tx.select({ id: thread.id }).from(thread).where(eq(thread.id, threadId)).for("update");
    const [row] = await tx
      .select({ value: max(threadEvent.sequence) })
      .from(threadEvent)
      .where(eq(threadEvent.threadId, threadId));
    const seq = (row?.value ?? 0) + 1;
    const event: ThreadEvent = {
      id: randomUUID(),
      threadId,
      sequence: seq,
      type,
      payload,
      runId: runId ?? null,
      createdAt: new Date(),
    };
    await tx.insert(threadEvent).values(event);
    // 12-成功落库后广播到进程内事件总线，供 SSE 端点即时推送各面板。
    // 跨实例变更由 SSE 端点 DB 轮询补推（ThreadEvent 表是跨实例真相源）。
    broadcastThreadEvent({
      threadId,
      type,
      payload,
      sequence: seq,
      createdAt: event.createdAt,
    });
    return event;
  });
}

/**
 * 查询某 thread 的全部事件（按 sequence 升序）。
 */
export async function listThreadEvents(threadId: string): Promise<ThreadEvent[]> {
  return db
    .select()
    .from(threadEvent)
    .where(eq(threadEvent.threadId, threadId))
    .orderBy(asc(threadEvent.sequence))
    .limit(500);
}

/**
 * 12-跨实例事件通道——DB 增量轮询。
 * 返回某 thread 自 since 的新事件（按 sequence 升序），供 SSE 端点补推他实例产生的事件。
 * 与 listThreadStatusChanges 互补：本查询面向单 thread 全事件类型，供详情页各面板订阅。
 */
export async function listThreadEventsSince(threadId: string, since: Date): Promise<ThreadEvent[]> {
  return db
    .select()
    .from(threadEvent)
    .where(and(eq(threadEvent.threadId, threadId), gt(threadEvent.createdAt, since)))
    .orderBy(asc(threadEvent.sequence))
    .limit(500);
}

/**
 * 查询某 thread 的 QA 检查事件（qa.check_passed / qa.check_failed），按 sequence 降序
 * （最近在前，供 Studio QA 面板展示）。不改既有查询语义，只追加新查询。
 */
export async function listQaEventsByThread(threadId: string): Promise<ThreadEvent[]> {
  return db
    .select()
    .from(threadEvent)
    .where(
      and(
        eq(threadEvent.threadId, threadId),
        inArray(threadEvent.type, ["qa.check_passed", "qa.check_failed"]),
      ),
    )
    .orderBy(desc(threadEvent.sequence));
}

/**
 * 统计 thread 最近连续 QA gate 失败次数。
 *
 * 从最近事件倒序扫描,遇到 qa.check_failed 计数,遇到 qa.check_passed 停止。
 * 用于 gate 重试上限判定:连续 N 次失败 → 转人工审核(防 agent 无限重试烧 token)。
 *
 * @returns 连续失败次数(0 表示最近一次通过或无 QA 事件)
 */
export async function countConsecutiveQaGateFailures(threadId: string): Promise<number> {
  const events = await db
    .select({ type: threadEvent.type })
    .from(threadEvent)
    .where(
      and(
        eq(threadEvent.threadId, threadId),
        inArray(threadEvent.type, ["qa.check_passed", "qa.check_failed"]),
      ),
    )
    .orderBy(desc(threadEvent.sequence))
    .limit(50); // 扫最近 50 条足够,避免长历史全量扫
  let count = 0;
  for (const e of events) {
    if (e.type === "qa.check_failed") count++;
    else break; // 遇到 passed 停止
  }
  return count;
}

// ─── Tool Run Queries (结构化工具执行记录) ───────────

/**
 * 创建一个 tool run 记录（默认状态 running）。
 *
 * `status` 可选，ask 暂停时传 `awaiting_approval`，以区分「被治理暂停」与「业务失败」。
 *
 * @returns 新创建的 ToolRun（含 id，用于后续 finish 调用）
 */
export async function createToolRun(params: {
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  status?: ToolRunStatus;
  /** 归属历史 run（nullable（历史记录可空））。 */
  runId?: string | null;
}): Promise<ToolRun> {
  // json 列 zod 校验（fail-closed，脏数据抛错不落库）
  const input = validateJsonColumn(params.input, toolRunInputSchema, "input");
  // MySQL 不支持 RETURNING，自行生成主键并构造返回对象。
  const run: ToolRun = {
    id: randomUUID(),
    threadId: params.threadId,
    toolName: params.toolName,
    status: params.status ?? "running",
    input,
    output: null,
    error: null,
    startedAt: new Date(),
    finishedAt: null,
    runId: params.runId ?? null,
  };
  await db.insert(toolRun).values(run);
  return run;
}

/**
 * 标记 tool run 为成功，回填 output / finishedAt。
 */
export async function finishToolRunSuccess(
  toolRunId: string,
  output: Record<string, unknown>,
): Promise<void> {
  // json 列 zod 校验（fail-closed）
  const validatedOutput = validateJsonColumn(output, toolRunOutputSchema, "output");
  await db
    .update(toolRun)
    .set({ status: "succeeded", output: validatedOutput, finishedAt: new Date() })
    .where(and(eq(toolRun.id, toolRunId), eq(toolRun.status, "running")));
}

/**
 * 标记 tool run 为失败，回填 error / finishedAt。
 */
export async function finishToolRunFailure(toolRunId: string, error: string): Promise<void> {
  await db
    .update(toolRun)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(and(eq(toolRun.id, toolRunId), eq(toolRun.status, "running")));
}

/**
 * 审计修复：将指定 thread 所有仍处于 "running" 的 ToolRun 标记为 "failed"。
 *
 * 当 thread run 被取消或异常失败时，可能还有工具正在执行。cancelRun / markFailed
 * 更新了 thread 状态但未处理进行中的 ToolRun，导致这些行永久停留在 "running"
 * （finishedAt=null）。Studio 的 tool-trace 面板和按 status 过滤的查询会看到幽灵条目。
 */
export async function failRunningToolRunsForThread(
  threadId: string,
  reason: string,
  runId?: string,
): Promise<void> {
  // : 限定 runId 防误杀——cancel/markFailed 后用户立即发新消息触发新 run,
  // 旧批量 fail 若不带 runId 会把新 run 刚 createToolRun(status=running) 的工具也标 failed。
  const conds = [eq(toolRun.threadId, threadId), eq(toolRun.status, "running")];
  if (runId) conds.push(eq(toolRun.runId, runId));
  await db
    .update(toolRun)
    .set({ status: "failed", error: reason, finishedAt: new Date() })
    .where(and(...conds));
}

// ─── Tool Run 查询 (a 上下文压缩数据源) ──────────────────

/**
 * 列某 thread 的 toolRun（按 startedAt desc）。供上下文压缩提取 toolRun/diff/debug 摘要。
 * limit 默认 100、上限 500、下限 1。
 */
export async function listToolRunsByThread(threadId: string, limit = 100): Promise<ToolRun[]> {
  const clamped = Math.min(500, Math.max(1, Math.floor(limit)));
  return db
    .select()
    .from(toolRun)
    .where(eq(toolRun.threadId, threadId))
    .orderBy(desc(toolRun.startedAt))
    .limit(clamped);
}

/** 取 thread 最近一次失败的 toolRun（按 startedAt desc），无则 null。供 protected recentFailure。 */
export async function getRecentFailedToolRun(threadId: string): Promise<ToolRun | null> {
  const [row] = await db
    .select()
    .from(toolRun)
    .where(and(eq(toolRun.threadId, threadId), eq(toolRun.status, "failed")))
    .orderBy(desc(toolRun.startedAt))
    .limit(1);
  return row ?? null;
}

// ─── Skill Registry Queries (Phase 3) ────────────────────────

/**
 * 取 skill 当前生效版本（currentVersionId 指向的版本）。
 * 无版本返回 null。
 */
export async function getCurrentSkillVersionBySkill(skill: {
  currentVersionId: string | null;
}): Promise<SkillVersion | null> {
  if (!skill.currentVersionId) return null;
  return getSkillVersion(skill.currentVersionId);
}

/**
 * 列出运行时可参与匹配的 skill（02 文档 §六.1）。
 *
 * 规则：
 * - status=active 且 visibility=public。
 * - source=local：始终进入候选。
 * - source=capability-market：仅当其同步映射 syncState=active 时进入候选。
 * 远端 hide / block_sync / not_found / name_conflict / error 的同步 Skill 不进入候选。
 *
 * V8：不再有"默认 skill"概念，build-from-idea 是普通 skill 可被 Resolver 选中。
 */
export async function listActiveSkillsForMatching(): Promise<Skill[]> {
  const activeSyncedSkillIds = db
    .select({ id: skillSyncMapping.localSkillId })
    .from(skillSyncMapping)
    .where(eq(skillSyncMapping.syncState, "active"));
  return db
    .select()
    .from(skill)
    .where(
      and(
        eq(skill.visibility, "public"),
        eq(skill.status, "active"),
        or(eq(skill.source, "local"), inArray(skill.id, activeSyncedSkillIds)),
      ),
    )
    .orderBy(asc(skill.createdAt));
}

/**
 * 按 name 取 skill。
 */
export async function getSkillByName(name: string): Promise<Skill | null> {
  const [row] = await db.select().from(skill).where(eq(skill.name, name)).limit(1);
  return row ?? null;
}

/**
 * 按 id 取 skill。
 */
export async function getSkillById(id: string): Promise<Skill | null> {
  const [row] = await db.select().from(skill).where(eq(skill.id, id)).limit(1);
  return row ?? null;
}

/**
 * 按 id 取 skill 版本。
 */
export async function getSkillVersion(id: string): Promise<SkillVersion | null> {
  const [row] = await db.select().from(skillVersion).where(eq(skillVersion.id, id)).limit(1);
  return row ?? null;
}

/** 按 skill + commitSha 查版本，用于 git commit 已成功但 DB 写入失败后的可重试恢复。 */
export async function getSkillVersionByCommitSha(
  skillId: string,
  commitSha: string,
): Promise<SkillVersion | null> {
  const [row] = await db
    .select()
    .from(skillVersion)
    .where(and(eq(skillVersion.skillId, skillId), eq(skillVersion.commitSha, commitSha)))
    .limit(1);
  return row ?? null;
}

/** 取 skill 当前最大版本号；无版本返回 0。 */
export async function getMaxSkillVersionNumber(skillId: string): Promise<number> {
  const [row] = await db
    .select({ value: max(skillVersion.version) })
    .from(skillVersion)
    .where(eq(skillVersion.skillId, skillId));
  return Number(row?.value ?? 0);
}

/**
 * 取 skill 当前生效版本（`skills.currentVersionId` 指向的 `skill_versions`）。
 * 无 skill 或未设置 currentVersionId 时返回 null。
 */
export async function getCurrentSkillVersion(skillId: string): Promise<SkillVersion | null> {
  const sk = await getSkillById(skillId);
  if (!sk || !sk.currentVersionId) return null;
  return getSkillVersion(sk.currentVersionId);
}

// V8 阶段 8：getActiveSkillForThread 已删除。
// 旧语义：从 thread.activeSkillId/activeSkillVersionId 解析 skill + version（含默认 skill 兜底）。
// V8 替代：chat 路径用 SkillProvider + Resolver（阶段 1-3），每轮 run 独立解析并记录 Skill 使用事实。
// 旧 thread.activeSkillId/activeSkillVersionId 字段保留兼容旧数据，但运行时不再读取。

/**
 * 创建一个 skill（身份层）。
 * source=local（本地自建，默认）或 capability-market（同步镜像，由同步服务写入）。
 */
export async function createSkill(
  params: {
    name: string;
    description?: string | null;
    category?: string | null;
    visibility?: string;
    status?: SkillStatus;
    ownerUserId?: string | null;
    source?: SkillSource;
  },
  tx?: DbTxClient,
): Promise<Skill> {
  const client = tx ?? db;
  const row: Skill = {
    id: randomUUID(),
    name: params.name,
    description: params.description ?? null,
    category: params.category ?? null,
    visibility: params.visibility ?? "public",
    status: params.status ?? "active",
    currentVersionId: null,
    ownerUserId: params.ownerUserId ?? null,
    source: params.source ?? "local",
    createdAt: new Date(),
    deletedAt: null,
  };
  await client.insert(skill).values(row);
  return row;
}

/**
 * 创建一个 skill 版本（不可变）。version 由调用方指定（通常 = 当前最大 +1）。
 * 不自动切换 currentVersionId——由 setCurrentVersion 显式完成，便于 seed/迁移分步。
 */
export async function createSkillVersion(
  params: {
    skillId: string;
    version: number;
    /** 保留；目录形态下新版本留空，内容由 skills/<name>/SKILL.md 承载 */
    promptTemplate?: string | null;
    /** 目录形态版本快照引用（skills/ git repo 的 commit sha）；迁移期旧版本可能为空 */
    commitSha?: string | null;
    allowedTools?: string[] | null;
    /** V8：能力声明（string[]），只用于 Resolver 判断和 Studio 提示，不限制工具可见性 */
    requiredCapabilities?: string[] | null;
    defaultModelProfile?: string | null;
    completionCriteria?: Record<string, unknown> | null;
    reviewMode?: string;
    artifactPolicy?: Record<string, unknown> | null;
    status?: SkillVersionStatus;
    runtimeType?: string | null;
  },
  tx?: DbTxClient,
): Promise<SkillVersion> {
  const row: SkillVersion = {
    id: randomUUID(),
    skillId: params.skillId,
    version: params.version,
    promptTemplate: params.promptTemplate ?? null,
    commitSha: params.commitSha ?? null,
    allowedTools: params.allowedTools ?? null,
    requiredCapabilities: params.requiredCapabilities ?? null,
    defaultModelProfile: params.defaultModelProfile ?? null,
    completionCriteria: params.completionCriteria ?? null,
    reviewMode: params.reviewMode ?? "auto",
    artifactPolicy: params.artifactPolicy ?? null,
    runtimeType: params.runtimeType ?? null,
    status: params.status ?? "active",
    createdAt: new Date(),
  };
  await (tx ?? db).insert(skillVersion).values(row);
  return row;
}

/**
 * 更新 skill 身份层稳定属性（name / description / category / visibility）。
 * 仅写传入字段。name 改名可能撞唯一索引 → 调用方 catch 转 409。
 * 可变内容（SKILL.md / 支持文件）不在本函数：编辑工作副本 + 发布新版本走 skill repo。
 */
export async function updateSkill(
  skillId: string,
  patch: {
    name?: string;
    description?: string | null;
    category?: string | null;
    visibility?: string;
  },
): Promise<void> {
  const sets: Record<string, unknown> = {};
  if (patch.name !== undefined) sets.name = patch.name;
  if (patch.description !== undefined) sets.description = patch.description;
  if (patch.category !== undefined) sets.category = patch.category;
  if (patch.visibility !== undefined) sets.visibility = patch.visibility;
  if (Object.keys(sets).length === 0) return;
  await db.update(skill).set(sets).where(eq(skill.id, skillId));
}

/**
 * 切换 skill 的当前生效版本（回填 skills.currentVersionId）。
 */
/**
 * 切换 skill 当前版本。
 * : 可选 `expectedCurrentVersionId` 做 CAS——仅当当前 currentVersionId 匹配时才切换,
 * 防两个 admin 并发 publish/rollback 不同的 versionId 互相覆盖(后写者赢且无冲突反馈)。
 * @returns 是否实际更新(expectedFrom 不匹配返回 false)
 */
export async function setCurrentVersion(
  skillId: string,
  versionId: string,
  expectedCurrentVersionId?: string | null,
  tx?: DbTxClient,
): Promise<boolean> {
  const client = tx ?? db;
  const conds = [eq(skill.id, skillId)];
  if (expectedCurrentVersionId !== undefined) {
    // currentVersionId 可空:null 用 isNull,否则 eq
    if (expectedCurrentVersionId === null) {
      conds.push(isNull(skill.currentVersionId));
    } else {
      conds.push(eq(skill.currentVersionId, expectedCurrentVersionId));
    }
  }
  const result = await client
    .update(skill)
    .set({ currentVersionId: versionId })
    .where(and(...conds));
  return (result as unknown as { affectedRows?: number }).affectedRows !== 0;
}

/**
 * 归档 skill（status → archived）。身份层保留，不物理删除——历史 thread 的版本固化不受影响。
 * publish / rollback 复用 setCurrentVersion，本函数仅用于「下线」。
 * : CAS——仅 status != archived 时归档(防并发 unarchive/archive 竞态)。
 */
export async function archiveSkill(skillId: string): Promise<boolean> {
  const result = await db
    .update(skill)
    .set({ status: "archived" })
    .where(and(eq(skill.id, skillId), ne(skill.status, "archived")));
  return (result as unknown as { affectedRows?: number }).affectedRows !== 0;
}

/** 创建 skill 失败补偿：仅用于还没有对外生效的新 skill，先删版本再删身份层。 */
export async function deleteSkillWithVersions(skillId: string): Promise<void> {
  await db.delete(skillVersion).where(eq(skillVersion.skillId, skillId));
  await db.delete(skill).where(eq(skill.id, skillId));
}

// ─── SkillSyncMapping（02 文档 同步映射）────────────────

/** 按远端 asset_id 查映射（同步入口：判断是否已有映射、复用 localName）。 */
export async function getSyncMappingByRemoteAsset(
  remoteAssetId: string,
): Promise<SkillSyncMapping | null> {
  const [row] = await db
    .select()
    .from(skillSyncMapping)
    .where(eq(skillSyncMapping.remoteAssetId, remoteAssetId))
    .limit(1);
  return row ?? null;
}

/** 按本地 skill id 查映射（Studio 详情展示、只读判断）。 */
export async function getSyncMappingByLocalSkill(
  localSkillId: string,
): Promise<SkillSyncMapping | null> {
  const [row] = await db
    .select()
    .from(skillSyncMapping)
    .where(eq(skillSyncMapping.localSkillId, localSkillId))
    .limit(1);
  return row ?? null;
}

/** 列出全部映射（同步服务比对远端资产是否仍存在）。 */
export async function listAllSyncMappings(): Promise<SkillSyncMapping[]> {
  return db.select().from(skillSyncMapping).orderBy(asc(skillSyncMapping.remoteAssetId));
}

/** 创建同步映射（首次导入远端 asset 时）。 */
export async function createSyncMapping(
  params: {
    remoteAssetId: string;
    remoteName: string | null;
    remoteDisplayName: string | null;
    remoteVersion: string | null;
    remoteVersionId: string | null;
    remoteContentHash: string | null;
    localSkillId: string;
    localSkillVersionId: string | null;
    localName: string;
    syncState?: SkillSyncState;
    lastError?: string | null;
  },
  tx?: DbTxClient,
): Promise<SkillSyncMapping> {
  const client = tx ?? db;
  const now = new Date();
  const row: SkillSyncMapping = {
    id: randomUUID(),
    source: "capability-market",
    remoteAssetId: params.remoteAssetId,
    remoteName: params.remoteName,
    remoteDisplayName: params.remoteDisplayName,
    remoteVersion: params.remoteVersion,
    remoteVersionId: params.remoteVersionId,
    remoteContentHash: params.remoteContentHash,
    localSkillId: params.localSkillId,
    localSkillVersionId: params.localSkillVersionId,
    localName: params.localName,
    syncState: params.syncState ?? "active",
    lastSyncedAt: params.syncState === "active" || params.syncState === undefined ? now : null,
    lastCheckedAt: now,
    lastError: params.lastError ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await client.insert(skillSyncMapping).values(row);
  return row;
}

/** 更新映射（同步成功 / 状态变化 / 错误记录）。仅写传入字段。 */
export async function updateSyncMapping(
  mappingId: string,
  patch: {
    remoteName?: string | null;
    remoteDisplayName?: string | null;
    remoteVersion?: string | null;
    remoteVersionId?: string | null;
    remoteContentHash?: string | null;
    localSkillVersionId?: string | null;
    syncState?: SkillSyncState;
    lastSyncedAt?: Date | null;
    lastCheckedAt?: Date | null;
    lastError?: string | null;
  },
  tx?: DbTxClient,
): Promise<void> {
  const client = tx ?? db;
  const sets: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.remoteName !== undefined) sets.remoteName = patch.remoteName;
  if (patch.remoteDisplayName !== undefined) sets.remoteDisplayName = patch.remoteDisplayName;
  if (patch.remoteVersion !== undefined) sets.remoteVersion = patch.remoteVersion;
  if (patch.remoteVersionId !== undefined) sets.remoteVersionId = patch.remoteVersionId;
  if (patch.remoteContentHash !== undefined) sets.remoteContentHash = patch.remoteContentHash;
  if (patch.localSkillVersionId !== undefined) sets.localSkillVersionId = patch.localSkillVersionId;
  if (patch.syncState !== undefined) sets.syncState = patch.syncState;
  if (patch.lastSyncedAt !== undefined) sets.lastSyncedAt = patch.lastSyncedAt;
  if (patch.lastCheckedAt !== undefined) sets.lastCheckedAt = patch.lastCheckedAt;
  if (patch.lastError !== undefined) sets.lastError = patch.lastError;
  await client.update(skillSyncMapping).set(sets).where(eq(skillSyncMapping.id, mappingId));
}

// V8 阶段 8：setThreadSkill 已删除。
// 旧语义：设置 thread.activeSkillId/activeSkillVersionId（版本固化）。
// V8 替代：chat 路径用 run 级 Skill 使用事实记录（阶段 2）。
// 旧字段保留兼容旧数据，但不再写入。


// ─── Policy Config 写入 () ──────────────────

/**
 * 整配置覆盖 PolicyConfig：事务内删掉给定 key 的旧行，再插入规范化新行。
 *
 * Policy PUT 是「整配置提交」（4 个白名单 key 全量），故用 delete+insert 覆盖语义,
 * 避免单行 upsert 留下未更新的脏行。调用方负责先用 validatePolicyRows 规范化。
 */
export async function replacePolicyConfigRows(
  rows: Array<{ key: string; value: unknown }>,
): Promise<void> {
  const keys = rows.map((r) => r.key);
  const now = new Date();
  await db.transaction(async (tx) => {
    if (keys.length > 0) {
      await tx.delete(policyConfig).where(inArray(policyConfig.key, keys));
    }
    if (rows.length > 0) {
      await tx
        .insert(policyConfig)
        .values(rows.map((r) => ({ key: r.key, value: r.value, updatedAt: now })));
    }
  });
}

/**
 * 记录 policy 配置变更历史（before/after 快照 + changedKeys）。
 * 由 PUT /studio/api/policies 在 replacePolicyConfigRows 后调用。
 */
export async function insertPolicyConfigHistory(params: {
  changedBy: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  changedKeys: string | null;
}): Promise<void> {
  await db.insert(policyConfigHistory).values({
    changedBy: params.changedBy,
    beforeSnapshot: params.beforeSnapshot,
    afterSnapshot: params.afterSnapshot,
    changedKeys: params.changedKeys,
    changedAt: new Date(),
  });
}

// ─── Admin Audit Queries (切片 C: append-only 审计) ──
//
// 仅 append + list，**不提供 update/delete**（约束 7）。metadata 由调用方经
// lib/studio/admin-audit.ts#sanitizeAuditMetadata 脱敏后传入；本层不做二次脱敏。

export type AppendAdminAuditLogInput = {
  actorUserId: string;
  action: AdminAuditAction;
  targetType: string;
  targetId: string;
  outcome: AdminAuditOutcome;
  metadata: Record<string, unknown>;
};

/**
 * 追加一条审计记录。MySQL 不支持 RETURNING，自行生成主键并构造返回对象。
 * metadata 必须是可 JSON 序列化的对象（调用方负责脱敏）。
 */
export async function appendAdminAuditLog(
  input: AppendAdminAuditLogInput,
  tx?: DbTxClient,
): Promise<AdminAuditLog> {
  const row = buildAdminAuditLogRow(input);
  await (tx ?? db).insert(adminAuditLog).values(row);
  return row;
}

/** 构造一条审计行（不落库），供 appendAdminAuditLog 与事务内插入复用。 */
function buildAdminAuditLogRow(input: AppendAdminAuditLogInput): AdminAuditLog {
  return {
    id: randomUUID(),
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    outcome: input.outcome,
    metadata: input.metadata,
    createdAt: new Date(),
  };
}

/**
 * 列审计记录，按 createdAt desc。limit 默认 100、上限 200、下限 1。
 * 可按 actor / action / targetType / targetId 过滤。空入参 → 默认查询。
 */
/**
 * 审计日志行：AdminAuditLog 全字段 + 操作者可读名（供 UI 显示，避免裸 actorUserId）。
 * actor 已删档 → actorName/actorEmail=null（leftJoin）。
 */
export type AuditLogRow = AdminAuditLog & {
  actorName: string | null;
  actorEmail: string | null;
};

export async function listAdminAuditLogs(params?: {
  limit?: number;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  action?: AdminAuditAction;
}): Promise<AuditLogRow[]> {
  const rawLimit = params?.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
      : 100;
  const conds = [];
  if (params?.actorUserId) conds.push(eq(adminAuditLog.actorUserId, params.actorUserId));
  if (params?.action) conds.push(eq(adminAuditLog.action, params.action));
  if (params?.targetType) conds.push(eq(adminAuditLog.targetType, params.targetType));
  if (params?.targetId) conds.push(eq(adminAuditLog.targetId, params.targetId));
  const base = db
    .select({
      id: adminAuditLog.id,
      actorUserId: adminAuditLog.actorUserId,
      action: adminAuditLog.action,
      targetType: adminAuditLog.targetType,
      targetId: adminAuditLog.targetId,
      outcome: adminAuditLog.outcome,
      metadata: adminAuditLog.metadata,
      createdAt: adminAuditLog.createdAt,
      actorName: user.name,
      actorEmail: user.email,
    })
    .from(adminAuditLog)
    .leftJoin(user, eq(adminAuditLog.actorUserId, user.id));
  const query = conds.length > 0 ? base.where(and(...conds)) : base;
  return query.orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id)).limit(limit);
}


// ─── Context Snapshot Queries (Stage C) ────────────────
//
// 每次模型调用前构建的 context manifest 落库。manifest 只记来源与摘要，调用方负责
// 不塞完整 prompt / 用户消息正文 / 完整工具输出（隐私约束）。

/** 创建一条 context snapshot（MySQL 不支持 RETURNING，自行生成主键并构造返回对象）。 */
export async function saveContextSnapshot(params: {
  threadId: string;
  trigger: string;
  model: string;
  runtimeType?: string | null;
  activeSkillVersionId?: string | null;
  toolNames: string[];
  layers: unknown;
  protectedRefs: unknown;
  excludedCandidates: unknown;
  checksums: Record<string, string>;
  estimatedTokens: number;
  /** 本轮是否压缩装配（与真实模型输入一致）。 */
  compressed?: boolean;
  /** 本轮装配后真实模型输入 token（nullable（旧快照可空））。 */
  afterTokens?: number | null;
  /** V8：本轮 Skill Resolver 输入摘要（availableSkillCount / uiSelectedSkillIds）。 */
  skillResolverInput?: unknown;
  /** V8：本轮 Skill Resolver 输出摘要。 */
  skillResolverOutput?: unknown;
  /** V8：readSkillFile 加载证据（运行结束 flush 写入；创建时省略）。 */
  skillLoadEvidence?: unknown;
  /** 归属历史 run（nullable（历史快照可空））。 */
  runId?: string | null;
}): Promise<ContextSnapshot> {
  // json 列 zod 校验（fail-closed，脏数据抛错不落库）
  const layers = validateJsonColumn(params.layers, contextSnapshotLayersSchema, "layers");
  const checksums = validateJsonColumn(
    params.checksums,
    contextSnapshotChecksumsSchema,
    "checksums",
  );
  const skillResolverInput = params.skillResolverInput
    ? validateJsonColumn(
        params.skillResolverInput,
        contextSnapshotSkillResolverInputSchema,
        "skillResolverInput",
      )
    : null;
  const skillResolverOutput = params.skillResolverOutput
    ? validateJsonColumn(
        params.skillResolverOutput,
        contextSnapshotSkillResolverOutputSchema,
        "skillResolverOutput",
      )
    : null;
  const row: ContextSnapshot = {
    id: randomUUID(),
    threadId: params.threadId,
    trigger: params.trigger,
    model: params.model,
    runtimeType: params.runtimeType ?? null,
    activeSkillVersionId: params.activeSkillVersionId ?? null,
    toolNames: params.toolNames,
    layers,
    protectedRefs: params.protectedRefs,
    excludedCandidates: params.excludedCandidates,
    checksums,
    estimatedTokens: params.estimatedTokens,
    compressed: params.compressed ?? false,
    afterTokens: params.afterTokens ?? null,
    skillResolverInput,
    skillResolverOutput,
    skillLoadEvidence: null,
    runId: params.runId ?? null,
    createdAt: new Date(),
  };
  await db.insert(contextSnapshot).values(row);
  return row;
}

/**
 * V8：把 readSkillFile 加载证据写回某 run 最近一条 ContextSnapshot（运行结束 flush 调用）。
 *
 * fail-open：找不到快照或写入失败只记 log，不抛出（证据是可观测性数据，不阻断 run 收尾）。
 * 同时支持 null evidence（清空占位，理论上不使用）。
 */
export async function attachSkillLoadEvidence(runId: string, evidence: unknown): Promise<void> {
  try {
    const validated = validateJsonColumn(
      evidence,
      contextSnapshotSkillLoadEvidenceSchema,
      "skillLoadEvidence",
    );
    // 取该 run 最近一条快照（run 维度，通常只有一条 chat.user_message 触发）
    const [latest] = await db
      .select({ id: contextSnapshot.id })
      .from(contextSnapshot)
      .where(eq(contextSnapshot.runId, runId))
      .orderBy(desc(contextSnapshot.createdAt), desc(contextSnapshot.id))
      .limit(1);
    if (!latest) return;
    await db
      .update(contextSnapshot)
      .set({ skillLoadEvidence: validated })
      .where(eq(contextSnapshot.id, latest.id));
  } catch (error) {
    logger.warn("[attachSkillLoadEvidence] 写入失败（fail-open）", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 取某 thread 最近的 context snapshot（按 createdAt desc）。limit 默认 20、上限 100、下限 1。
 */
export async function listContextSnapshotsForThread(
  threadId: string,
  limit = 20,
): Promise<ContextSnapshot[]> {
  const clamped = Math.min(100, Math.max(1, Math.floor(limit)));
  return db
    .select()
    .from(contextSnapshot)
    .where(eq(contextSnapshot.threadId, threadId))
    .orderBy(desc(contextSnapshot.createdAt), desc(contextSnapshot.id))
    .limit(clamped);
}

// ─── Context Summary Queries (a) ────────────────────────
//
// 压缩派生视图的 CRUD。一行 = 一个被摘要的消息区段或工具证据区段。
// supersede 链：区段扩展被重新摘要时，旧 summary.supersededById 指向新 summary；
// 查询只取未 supersede 的（supersededById IS NULL）。

/** 创建一条 ContextSummary。 */
export async function createContextSummary(params: {
  threadId: string;
  type: ContextSummaryType;
  scope: unknown;
  summaryText: string;
  checksum: string;
  tokenEstimate: number;
  originalTokenEstimate: number;
  protectedRefs: unknown;
}): Promise<ContextSummary> {
  const row: ContextSummary = {
    id: randomUUID(),
    threadId: params.threadId,
    type: params.type,
    scope: params.scope,
    summaryText: params.summaryText,
    checksum: params.checksum,
    tokenEstimate: params.tokenEstimate,
    originalTokenEstimate: params.originalTokenEstimate,
    protectedRefs: params.protectedRefs,
    supersededById: null,
    createdAt: new Date(),
  };
  await db.insert(contextSummary).values(row);
  return row;
}

/**
 * 按 checksum 查活跃 summary（未 supersede）。命中则复用，不重算。
 * 返回 null 表示无可用复用。
 */
export async function getActiveSummaryByChecksum(
  threadId: string,
  checksum: string,
): Promise<ContextSummary | null> {
  const [row] = await db
    .select()
    .from(contextSummary)
    .where(
      and(
        eq(contextSummary.threadId, threadId),
        eq(contextSummary.checksum, checksum),
        isNull(contextSummary.supersededById),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 列某 thread 的全部 summary（按 createdAt desc）。默认只取未 supersede 的活跃摘要；
 * includeSuperseded=true 时返回全部（含历史链）。
 */
export async function listSummariesByThread(
  threadId: string,
  options?: { limit?: number; includeSuperseded?: boolean },
): Promise<ContextSummary[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(options?.limit ?? 50)));
  const conditions = [eq(contextSummary.threadId, threadId)];
  if (!options?.includeSuperseded) {
    conditions.push(isNull(contextSummary.supersededById));
  }
  return db
    .select()
    .from(contextSummary)
    .where(and(...conditions))
    .orderBy(desc(contextSummary.createdAt), desc(contextSummary.id))
    .limit(limit);
}

/**
 * Supersede：把旧 summary 标记为被新 summary 取代。
 * 旧 summary.supersededById 指向新 summary id；之后查询不再返回旧 summary。
 */
export async function supersedeSummary(params: {
  oldSummaryId: string;
  newSummaryId: string;
}): Promise<void> {
  await db
    .update(contextSummary)
    .set({ supersededById: params.newSummaryId })
    .where(eq(contextSummary.id, params.oldSummaryId));
}

/**
 * supersede 链 GC。
 *
 * supersedeSummary 只标记 supersededById 不删除，长期会话累积大量已 supersede 的旧 summary。
 * 本函数物理删除 `supersededById IS NOT NULL AND createdAt < now - retainDays` 的旧 summary，
 * 保留近期（默认 7 天）供审计/回看。由 retention 定时任务调用。
 * @returns 删除条数
 */
export async function cleanupSupersededSummaries(retainDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(contextSummary)
    .where(and(isNotNull(contextSummary.supersededById), lt(contextSummary.createdAt, cutoff)));
  // drizzle mysql delete 返回affected rows在result[0].affectedRows
  const affected = (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
  return affected;
}

// ─── Thread Plan / Todo Queries (Stage D) ──────────────
//
// thread 级计划容器与条目。不要求 agent 自动写计划，仅提供数据层与查询接口，
// 供后续 todoWrite / subagent / 状态恢复与 Studio 只读展示复用。所有查询带 threadId
// 过滤，不提供跨 thread 裸查。

/** 创建一个 thread plan（状态默认 active）。同时追加 plan.created 事件。 */
export async function createThreadPlan(params: {
  threadId: string;
  title: string;
  source?: string;
}): Promise<ThreadPlan> {
  const now = new Date();
  const row: ThreadPlan = {
    id: randomUUID(),
    threadId: params.threadId,
    title: params.title,
    status: "active",
    source: params.source ?? "system",
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(threadPlan).values(row);
  await appendThreadEvent(params.threadId, "plan.created", {
    planId: row.id,
    title: row.title,
    source: row.source,
  });
  return row;
}

/** 取 thread 当前 active plan（最近创建的一条 active）。无则 null。 */
export async function getActiveThreadPlan(threadId: string): Promise<ThreadPlan | null> {
  const [row] = await db
    .select()
    .from(threadPlan)
    .where(and(eq(threadPlan.threadId, threadId), eq(threadPlan.status, "active")))
    .orderBy(desc(threadPlan.createdAt), desc(threadPlan.id))
    .limit(1);
  return row ?? null;
}

/** 列 thread 全部 plan（按 createdAt desc）。 */
export async function listThreadPlans(threadId: string): Promise<ThreadPlan[]> {
  return db
    .select()
    .from(threadPlan)
    .where(eq(threadPlan.threadId, threadId))
    .orderBy(desc(threadPlan.createdAt), desc(threadPlan.id));
}

/**
 * 新增或更新一个 plan item。传入 id 已存在则更新（title/position/status/evidence/parentId
 * 任一非 undefined 字段），否则插入。返回最终行（MySQL 无 RETURNING，按入参构造）。
 */
export async function upsertThreadPlanItem(params: {
  id: string;
  planId: string;
  threadId: string;
  title?: string;
  position?: number;
  status?: ThreadPlanItemStatus;
  evidence?: unknown;
  parentId?: string | null;
}): Promise<ThreadPlanItem> {
  // 先探存在性
  const [existing] = await db
    .select()
    .from(threadPlanItem)
    .where(eq(threadPlanItem.id, params.id))
    .limit(1);
  const now = new Date();
  if (existing) {
    const sets: Record<string, unknown> = { updatedAt: now };
    if (params.title !== undefined) sets.title = params.title;
    if (params.position !== undefined) sets.position = params.position;
    if (params.status !== undefined) sets.status = params.status;
    if (params.evidence !== undefined) sets.evidence = params.evidence;
    if (params.parentId !== undefined) sets.parentId = params.parentId;
    await db.update(threadPlanItem).set(sets).where(eq(threadPlanItem.id, params.id));
    return { ...existing, ...sets } as ThreadPlanItem;
  }
  const row: ThreadPlanItem = {
    id: params.id,
    planId: params.planId,
    threadId: params.threadId,
    parentId: params.parentId ?? null,
    position: params.position ?? 0,
    title: params.title ?? "",
    status: params.status ?? "pending",
    evidence: params.evidence ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(threadPlanItem).values(row);
  return row;
}

/** 列 plan items（按 position asc）。planId 省略时取该 thread 全部 items。 */
export async function listThreadPlanItems(
  threadId: string,
  planId?: string,
): Promise<ThreadPlanItem[]> {
  const conds = [eq(threadPlanItem.threadId, threadId)];
  if (planId) conds.push(eq(threadPlanItem.planId, planId));
  return db
    .select()
    .from(threadPlanItem)
    .where(and(...conds))
    .orderBy(asc(threadPlanItem.position));
}

/**
 * 更新 item 状态，并写 plan.item_updated 事件。返回更新后的行（按入参 + existing 合并）。
 */
export async function updateThreadPlanItemStatus(params: {
  id: string;
  status: ThreadPlanItemStatus;
}): Promise<ThreadPlanItem | null> {
  const [existing] = await db
    .select()
    .from(threadPlanItem)
    .where(eq(threadPlanItem.id, params.id))
    .limit(1);
  if (!existing) return null;
  const now = new Date();
  await db
    .update(threadPlanItem)
    .set({ status: params.status, updatedAt: now })
    .where(eq(threadPlanItem.id, params.id));
  await appendThreadEvent(existing.threadId, "plan.item_updated", {
    itemId: existing.id,
    planId: existing.planId,
    status: params.status,
  });
  return { ...existing, status: params.status, updatedAt: now };
}

/** 放弃 plan（status → abandoned），并写 plan.updated 事件。 */
export async function abandonThreadPlan(planId: string): Promise<void> {
  const now = new Date();
  await db
    .update(threadPlan)
    .set({ status: "abandoned", updatedAt: now })
    .where(eq(threadPlan.id, planId));
  // 取 planId 的 threadId 用于事件归属
  const [row] = await db
    .select({ threadId: threadPlan.threadId })
    .from(threadPlan)
    .where(eq(threadPlan.id, planId))
    .limit(1);
  if (row) {
    await appendThreadEvent(row.threadId, "plan.updated", {
      planId,
      status: "abandoned",
    });
  }
}

// ─── Tool Permission Rule / Approval Request Queries () ──
//
// ask/deny/ask 权限引擎的数据层。规则默认从 PolicyConfig 派生（lib/permission/rules.ts），
// DB 行作覆盖；approval 记录 ask 暂停产生的待审批请求，批准复用语义由
// status=approved + approvedScope + argFingerprint 表达（不单建 ToolApproval 表）。

/** 列全部持久化权限规则（默认规则的 DB 覆盖）。按 priority 降序。 */
export async function listPermissionRules(): Promise<ToolPermissionRule[]> {
  return db.select().from(toolPermissionRule).orderBy(desc(toolPermissionRule.priority));
}

/**
 * 创建一条持久化权限规则（DB 覆盖默认规则）。无 UI 编辑入口，供 seed/测试用。
 *
 * actorUserId 非空时同事务落 permission_rule.created 审计行（input 经脱敏）。
 * seed 等无 actor 场景不传 actorUserId，不写审计（seed 行为可由 git 历史/部署日志追溯）。
 */
export async function createPermissionRule(params: {
  scope?: PermissionScope;
  scopeRef?: string | null;
  toolPattern: string;
  argMatcher?: Record<string, unknown> | null;
  decision: PermissionDecision;
  reason?: string | null;
  priority?: number;
  /** 操作者用户 id（非空时落审计）。 */
  actorUserId?: string | null;
}): Promise<ToolPermissionRule> {
  const now = new Date();
  const row: ToolPermissionRule = {
    id: randomUUID(),
    scope: params.scope ?? "global",
    scopeRef: params.scopeRef ?? null,
    toolPattern: params.toolPattern,
    argMatcher: params.argMatcher ?? null,
    decision: params.decision,
    reason: params.reason ?? null,
    priority: params.priority ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  const auditRow =
    params.actorUserId != null
      ? buildAdminAuditLogRow({
          actorUserId: params.actorUserId,
          action: "permission_rule.created",
          targetType: "permission_rule",
          targetId: row.id,
          outcome: "succeeded",
          metadata: {
            scope: row.scope,
            scopeRef: row.scopeRef,
            toolPattern: row.toolPattern,
            decision: row.decision,
            priority: row.priority,
          },
        })
      : null;
  await db.transaction(async (tx) => {
    await tx.insert(toolPermissionRule).values(row);
    if (auditRow) await tx.insert(adminAuditLog).values(auditRow);
  });
  return row;
}

/**
 * 更新一条持久化权限规则。
 *
 * 字段全可选，仅更新传入字段。actorUserId 非空时落 permission_rule.updated 审计。
 * 规则不存在 → 返回 null（调用方据此 404）。
 */
export async function updatePermissionRule(
  id: string,
  patch: {
    scope?: PermissionScope;
    scopeRef?: string | null;
    toolPattern?: string;
    argMatcher?: Record<string, unknown> | null;
    decision?: PermissionDecision;
    reason?: string | null;
    priority?: number;
  },
  actorUserId?: string | null,
): Promise<ToolPermissionRule | null> {
  const [existing] = await db
    .select()
    .from(toolPermissionRule)
    .where(eq(toolPermissionRule.id, id))
    .limit(1);
  if (!existing) return null;
  const sets: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) sets[k] = v;
  }
  const auditRow =
    actorUserId != null
      ? buildAdminAuditLogRow({
          actorUserId,
          action: "permission_rule.updated",
          targetType: "permission_rule",
          targetId: id,
          outcome: "succeeded",
          metadata: {
            before: {
              scope: existing.scope,
              toolPattern: existing.toolPattern,
              decision: existing.decision,
              priority: existing.priority,
            },
            after: sets,
          },
        })
      : null;
  await db.transaction(async (tx) => {
    await tx.update(toolPermissionRule).set(sets).where(eq(toolPermissionRule.id, id));
    if (auditRow) await tx.insert(adminAuditLog).values(auditRow);
  });
  return { ...existing, ...sets } as ToolPermissionRule;
}

/**
 * 删除一条持久化权限规则。
 * actorUserId 非空时落 permission_rule.deleted 审计。规则不存在 → 返回 false（调用方据此 404）。
 */
export async function deletePermissionRule(
  id: string,
  actorUserId?: string | null,
): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(toolPermissionRule)
    .where(eq(toolPermissionRule.id, id))
    .limit(1);
  if (!existing) return false;
  const auditRow =
    actorUserId != null
      ? buildAdminAuditLogRow({
          actorUserId,
          action: "permission_rule.deleted",
          targetType: "permission_rule",
          targetId: id,
          outcome: "succeeded",
          metadata: {
            scope: existing.scope,
            toolPattern: existing.toolPattern,
            decision: existing.decision,
          },
        })
      : null;
  await db.transaction(async (tx) => {
    await tx.delete(toolPermissionRule).where(eq(toolPermissionRule.id, id));
    if (auditRow) await tx.insert(adminAuditLog).values(auditRow);
  });
  return true;
}

/**
 * 创建一条审批请求（pending）。ask 暂停时由 executeToolRun 调用。
 * expiresAt 缺省时按 24h 过期设置（）。
 */
export async function createApprovalRequest(params: {
  threadId: string;
  toolRunId: string;
  toolName: string;
  permissionKey: string;
  argFingerprint: string;
  argSummary: string;
  expiresAt?: Date | null;
  projectId?: string | null;
}): Promise<ToolApprovalRequest> {
  const now = new Date();
  const row: ToolApprovalRequest = {
    id: randomUUID(),
    threadId: params.threadId,
    toolRunId: params.toolRunId,
    toolName: params.toolName,
    permissionKey: params.permissionKey,
    argFingerprint: params.argFingerprint,
    argSummary: params.argSummary,
    status: "pending",
    approvedScope: null,
    projectId: params.projectId ?? null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: now,
    expiresAt: params.expiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1000),
  };
  await db.insert(toolApprovalRequest).values(row);
  return row;
}

/**
 * 审批多步操作事务化。
 *
 * 原实现 createToolRun + createApprovalRequest + updateThreadStatus 分散调用，部分成功会留 thread
 * 卡在 executing。本函数在单事务内完成三步，保证原子性。事件追加在事务外（append-only best-effort）。
 */
export async function requestApprovalAtomic(params: {
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  permissionKey: string;
  argFingerprint: string;
  argSummary: string;
  projectId?: string | null;
  /** 归属历史 run（nullable（历史记录可空））。 */
  runId?: string | null;
}): Promise<{ run: ToolRun; approval: ToolApprovalRequest }> {
  // 与 createToolRun 同构：json 列 zod 校验（fail-closed，脏数据抛错不落库）。
  const input = validateJsonColumn(params.input, toolRunInputSchema, "input");
  return db.transaction(async (tx) => {
    const now = new Date();
    const run: ToolRun = {
      id: randomUUID(),
      threadId: params.threadId,
      toolName: params.toolName,
      status: "awaiting_approval",
      input,
      output: null,
      error: null,
      startedAt: now,
      finishedAt: null,
      runId: params.runId ?? null,
    };
    await tx.insert(toolRun).values(run);

    const approval: ToolApprovalRequest = {
      id: randomUUID(),
      threadId: params.threadId,
      toolRunId: run.id,
      toolName: params.toolName,
      permissionKey: params.permissionKey,
      argFingerprint: params.argFingerprint,
      argSummary: params.argSummary,
      status: "pending",
      approvedScope: null,
      // 审批请求记录 projectId，供 project scope 跨 thread 匹配
      projectId: params.projectId ?? null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    };
    await tx.insert(toolApprovalRequest).values(approval);

    await tx
      .update(thread)
      .set({ status: "awaiting_approval", updatedAt: now })
      .where(eq(thread.id, params.threadId));

    return { run, approval };
  });
}

/** 按 id 取审批请求。 */
export async function getApprovalRequest(id: string): Promise<ToolApprovalRequest | null> {
  const [row] = await db
    .select()
    .from(toolApprovalRequest)
    .where(eq(toolApprovalRequest.id, id))
    .limit(1);
  return row ?? null;
}

/** 列 thread 的 pending 审批请求（按 createdAt asc）。 */
export async function getPendingApprovalsByThread(
  threadId: string,
): Promise<ToolApprovalRequest[]> {
  return db
    .select()
    .from(toolApprovalRequest)
    .where(
      and(eq(toolApprovalRequest.threadId, threadId), eq(toolApprovalRequest.status, "pending")),
    )
    .orderBy(asc(toolApprovalRequest.createdAt));
}

/** 列 thread 最近已决议的审批请求（approved/denied，按 createdAt desc，限 50）。 */
export async function getResolvedApprovalsByThread(
  threadId: string,
  limit = 50,
): Promise<ToolApprovalRequest[]> {
  const clamped = Math.min(200, Math.max(1, Math.floor(limit)));
  return db
    .select()
    .from(toolApprovalRequest)
    .where(
      and(
        eq(toolApprovalRequest.threadId, threadId),
        inArray(toolApprovalRequest.status, ["approved", "denied"]),
      ),
    )
    .orderBy(desc(toolApprovalRequest.createdAt), desc(toolApprovalRequest.id))
    .limit(clamped);
}

/**
 * 决议一条审批请求：仅 status=pending 可被决议，否则返回 null（调用方据此返回 409）。
 * 写 tool.approval_resolved 事件由调用方（API 层）负责，本函数只更新请求行。
 */
export async function resolveApprovalRequest(params: {
  id: string;
  decision: "approved" | "denied";
  scope: ApprovalScope;
  resolvedBy: string;
}): Promise<ToolApprovalRequest | null> {
  const existing = await getApprovalRequest(params.id);
  if (!existing || existing.status !== "pending") return null;
  const now = new Date();
  const patch: Partial<ToolApprovalRequest> = {
    status: params.decision as ApprovalRequestStatus,
    approvedScope: params.scope,
    resolvedBy: params.resolvedBy,
    resolvedAt: now,
  };
  // session scope（07-）：决议时把 expiresAt 收紧到短 TTL，
  // 区别于 thread/always 的 24h。过期后引擎 isApprovalExpired 与 findMatchingApprovals
  // 同步失效，实现"同 thread 短期复用"语义。denied 不必调整 TTL（已拒绝不再复用）。
  if (params.decision === "approved" && params.scope === "session") {
    patch.expiresAt = new Date(now.getTime() + approvalConfig.sessionTtlMs);
  }
  // 审计修复(TOCTOU)：WHERE 加 status='pending' 守卫，affectedRows=0 说明已被并发决议
  const result = await db
    .update(toolApprovalRequest)
    .set(patch)
    .where(and(eq(toolApprovalRequest.id, params.id), eq(toolApprovalRequest.status, "pending")));
  if (affectedRowsOf(result) === 0) return null;
  return { ...existing, ...patch };
}

/**
 * 查找匹配的已批准审批请求（用于 ask→allow 升级）。
 * 匹配维度：permissionKey + argFingerprint + status=approved + 未过期。
 * 若传入 threadId，仅返回 always 或同 thread 候选；最终 scope 仍由引擎纯函数复核。
 * scope 适用性（thread/project/always）由引擎纯函数判断；本查询返回候选集。
 */
export async function findMatchingApprovals(params: {
  permissionKey: string;
  argFingerprint: string;
  threadId?: string;
  projectId?: string | null;
}): Promise<ToolApprovalRequest[]> {
  // scopeFilter 增加 project scope 跨 thread 匹配
  const threadFilter = params.threadId
    ? eq(toolApprovalRequest.threadId, params.threadId)
    : undefined;
  const projectFilter = params.projectId
    ? and(
        eq(toolApprovalRequest.approvedScope, "project"),
        eq(toolApprovalRequest.projectId, params.projectId),
      )
    : undefined;
  const scopeFilter =
    threadFilter || projectFilter
      ? or(eq(toolApprovalRequest.approvedScope, "always"), threadFilter, projectFilter)
      : undefined;
  return db
    .select()
    .from(toolApprovalRequest)
    .where(
      and(
        eq(toolApprovalRequest.permissionKey, params.permissionKey),
        eq(toolApprovalRequest.argFingerprint, params.argFingerprint),
        eq(toolApprovalRequest.status, "approved"),
        or(isNull(toolApprovalRequest.expiresAt), gt(toolApprovalRequest.expiresAt, new Date())),
        scopeFilter,
      ),
    )
    .orderBy(desc(toolApprovalRequest.resolvedAt));
}

/** 从不同 drizzle/mysql adapter 的 update 结果里提取 affectedRows。 */
function affectedRowsOf(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  if (
    candidate &&
    typeof candidate === "object" &&
    "affectedRows" in candidate &&
    typeof (candidate as { affectedRows: unknown }).affectedRows === "number"
  ) {
    return (candidate as { affectedRows: number }).affectedRows;
  }
  return 0;
}

/** 原子消费一次性 approval，抢到消费权才返回 true。 */
export async function consumeOnceApproval(id: string): Promise<boolean> {
  const result = await db
    .update(toolApprovalRequest)
    .set({ status: "superseded" })
    .where(
      and(
        eq(toolApprovalRequest.id, id),
        eq(toolApprovalRequest.status, "approved"),
        eq(toolApprovalRequest.approvedScope, "once"),
      ),
    );
  return affectedRowsOf(result) === 1;
}

/**
 * 取 thread 最近一条已决议的审批请求（approved/denied，按 resolvedAt desc）。
 * 供 chat route 恢复路径判断：thread 处于 awaiting_approval 时，最近决议决定恢复语义。
 */
export async function getLatestResolvedApprovalByThread(
  threadId: string,
): Promise<ToolApprovalRequest | null> {
  const [row] = await db
    .select()
    .from(toolApprovalRequest)
    .where(
      and(
        eq(toolApprovalRequest.threadId, threadId),
        inArray(toolApprovalRequest.status, ["approved", "denied"]),
      ),
    )
    .orderBy(desc(toolApprovalRequest.resolvedAt))
    .limit(1);
  return row ?? null;
}

// ─── Git Checkpoint Queries () ──────────────────────────
//
// 风险前快照的数据层。tag 名 + commitSha 由 lib/git/checkpoint.ts 经 ops.gitTag 产出；
// 本层只做 CRUD，事件追加（git.checkpoint_created/restored）由 checkpoint.ts 编排。

/** 创建一条 checkpoint 记录。MySQL 无 RETURNING，自行生成主键并构造返回对象。 */
export async function createCheckpointRow(params: {
  threadId: string;
  tag: string;
  commitSha: string;
  reason: string;
  createdByToolRunId?: string | null;
  filesChanged?: string | null;
}): Promise<GitCheckpoint> {
  const row: GitCheckpoint = {
    id: randomUUID(),
    threadId: params.threadId,
    tag: params.tag,
    commitSha: params.commitSha,
    reason: params.reason,
    createdByToolRunId: params.createdByToolRunId ?? null,
    restoredAt: null,
    filesChanged: params.filesChanged ?? null,
    createdAt: new Date(),
  };
  await db.insert(gitCheckpoint).values(row);
  return row;
}

/** 按 id 取 checkpoint。 */
export async function getCheckpoint(id: string): Promise<GitCheckpoint | null> {
  const [row] = await db.select().from(gitCheckpoint).where(eq(gitCheckpoint.id, id)).limit(1);
  return row ?? null;
}

/** 列 thread 的全部 checkpoint（按 createdAt desc，最近在前）。 */
export async function listCheckpointsByThread(threadId: string): Promise<GitCheckpoint[]> {
  return db
    .select()
    .from(gitCheckpoint)
    .where(eq(gitCheckpoint.threadId, threadId))
    .orderBy(desc(gitCheckpoint.createdAt), desc(gitCheckpoint.id));
}

/** 标记 checkpoint 已被 restore（回填 restoredAt）。返回更新后的行（按 existing 合并）。 */
export async function markCheckpointRestored(id: string): Promise<GitCheckpoint | null> {
  const [existing] = await db.select().from(gitCheckpoint).where(eq(gitCheckpoint.id, id)).limit(1);
  if (!existing) return null;
  const now = new Date();
  await db.update(gitCheckpoint).set({ restoredAt: now }).where(eq(gitCheckpoint.id, id));
  return { ...existing, restoredAt: now };
}

// ─── Memory Queries (b) ─────────────────────────────────
//
// MemoryEntry CRUD。store.ts 做去重/provenance 校验/soft delete/事件，这里只做纯 DB 操作。

export async function createMemoryRow(params: {
  scope: MemoryScope;
  scopeRef: string | null;
  kind: MemoryKind;
  text: string;
  textHash: string;
  provenance: MemoryProvenanceEntry[];
  confidence: MemoryConfidence;
  expiresAt: Date | null;
  createdByToolRunId: string | null;
}): Promise<MemoryEntry> {
  // json 列 zod 校验（fail-closed，provenance 必须非空防孤儿记忆）
  const provenance = validateJsonColumn(params.provenance, memoryProvenanceSchema, "provenance");
  const row: MemoryEntry = {
    id: randomUUID(),
    scope: params.scope,
    scopeRef: params.scopeRef,
    kind: params.kind,
    text: params.text,
    textHash: params.textHash,
    provenance,
    confidence: params.confidence,
    status: "active",
    expiresAt: params.expiresAt,
    createdByToolRunId: params.createdByToolRunId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(memoryEntry).values(row);
  return row;
}

export async function getMemoryRow(id: string): Promise<MemoryEntry | null> {
  const [row] = await db.select().from(memoryEntry).where(eq(memoryEntry.id, id)).limit(1);
  return row ?? null;
}

export async function listMemoryRows(filter: {
  scope: MemoryScope;
  scopeRef: string | null;
  kind?: MemoryKind;
  status?: "active" | "revoked";
}): Promise<MemoryEntry[]> {
  const conds = [eq(memoryEntry.scope, filter.scope)];
  if (filter.scopeRef !== null) conds.push(eq(memoryEntry.scopeRef, filter.scopeRef));
  else conds.push(isNull(memoryEntry.scopeRef));
  if (filter.kind) conds.push(eq(memoryEntry.kind, filter.kind));
  conds.push(eq(memoryEntry.status, filter.status ?? "active"));
  return db
    .select()
    .from(memoryEntry)
    .where(and(...conds))
    .orderBy(desc(memoryEntry.updatedAt), desc(memoryEntry.id));
}

export async function findDuplicateMemory(params: {
  scope: MemoryScope;
  scopeRef: string | null;
  kind: MemoryKind;
  textHash: string;
}): Promise<MemoryEntry | null> {
  const conds = [
    eq(memoryEntry.scope, params.scope),
    eq(memoryEntry.kind, params.kind),
    eq(memoryEntry.textHash, params.textHash),
    eq(memoryEntry.status, "active"),
  ];
  if (params.scopeRef !== null) conds.push(eq(memoryEntry.scopeRef, params.scopeRef));
  else conds.push(isNull(memoryEntry.scopeRef));
  const [row] = await db
    .select()
    .from(memoryEntry)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
}

export async function updateMemoryRow(
  id: string,
  patch: {
    status?: "active" | "revoked";
    confidence?: MemoryConfidence;
    provenance?: MemoryProvenanceEntry[];
    expiresAt?: Date | null;
    /** text 更新（同步 textHash）。 */
    text?: string;
    textHash?: string;
  },
): Promise<MemoryEntry | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.confidence !== undefined) set.confidence = patch.confidence;
  if (patch.provenance !== undefined) set.provenance = patch.provenance;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (patch.text !== undefined) set.text = patch.text;
  if (patch.textHash !== undefined) set.textHash = patch.textHash;
  await db.update(memoryEntry).set(set).where(eq(memoryEntry.id, id));
  const [row] = await db.select().from(memoryEntry).where(eq(memoryEntry.id, id)).limit(1);
  return row ?? null;
}

// ─── Memory Embedding Queries () ──────────────
//
// 一条 memory 每 provider 一向量（unique memoryId+provider）。upsertEmbeddingRow 查+插/改。
// getActiveEmbeddingRow 供 retrieveMemories semantic rerank：只取 status=active 的向量。

export async function upsertEmbeddingRow(params: {
  memoryId: string;
  provider: string;
  model: string;
  vector: number[];
  dim: number;
  status: "active" | "stale" | "error";
  errorMessage?: string | null;
}): Promise<MemoryEmbedding> {
  // : 改 INSERT ... ON DUPLICATE KEY UPDATE(依赖 memoryId+provider 唯一索引),
  // 消除原 SELECT-then-INSERT 竞态:并发双方都 select 空 → 都 INSERT → 一方撞唯一约束失败。
  const now = new Date();
  const row = {
    id: randomUUID(),
    memoryId: params.memoryId,
    provider: params.provider,
    model: params.model,
    vector: params.vector,
    dim: params.dim,
    status: params.status,
    errorMessage: params.errorMessage ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(memoryEmbedding)
    .values(row)
    .onDuplicateKeyUpdate({
      set: {
        model: sql`VALUES(model)`,
        vector: sql`VALUES(vector)`,
        dim: sql`VALUES(dim)`,
        status: sql`VALUES(status)`,
        errorMessage: sql`VALUES(errorMessage)`,
        updatedAt: sql`VALUES(updatedAt)`,
      },
    });
  return row;
}

export async function getActiveEmbeddingRow(
  memoryId: string,
  provider: string,
): Promise<MemoryEmbedding | null> {
  const [row] = await db
    .select()
    .from(memoryEmbedding)
    .where(
      and(
        eq(memoryEmbedding.memoryId, memoryId),
        eq(memoryEmbedding.provider, provider),
        eq(memoryEmbedding.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 批量取多条 memory 的 active embedding（单查询替代 N+1）。
 * 返回 Map<memoryId, MemoryEmbedding>（仅当前 provider 的 active 行）。
 */
export async function listActiveEmbeddingRows(
  memoryIds: string[],
  provider: string,
): Promise<Map<string, MemoryEmbedding>> {
  const out = new Map<string, MemoryEmbedding>();
  if (memoryIds.length === 0) return out;
  const rows = await db
    .select()
    .from(memoryEmbedding)
    .where(
      and(
        inArray(memoryEmbedding.memoryId, memoryIds),
        eq(memoryEmbedding.provider, provider),
        eq(memoryEmbedding.status, "active"),
      ),
    );
  for (const r of rows) out.set(r.memoryId, r);
  return out;
}

/**
 * provider 切换后老 embedding fallback。
 * 当前 provider 无 active embedding 时，取任意 provider 的 active embedding（老 provider 的），
 * 供 cosine 粗排（维度可能不匹配 → 调用方需校验 dim）。无则 null。
 */
export async function getActiveEmbeddingRowAnyProvider(
  memoryId: string,
): Promise<MemoryEmbedding | null> {
  const [row] = await db
    .select()
    .from(memoryEmbedding)
    .where(and(eq(memoryEmbedding.memoryId, memoryId), eq(memoryEmbedding.status, "active")))
    .limit(1);
  return row ?? null;
}

/**
 * 批量取任意 provider 的 active embedding（替代 N+1 循环调用 getActiveEmbeddingRowAnyProvider）。
 * 单查询 IN(...) 取所有 memoryId 的 active embedding 行，每个 memoryId 至多取一条。
 */
export async function listActiveEmbeddingRowsAnyProvider(
  memoryIds: string[],
): Promise<Map<string, MemoryEmbedding>> {
  const out = new Map<string, MemoryEmbedding>();
  if (memoryIds.length === 0) return out;
  const rows = await db
    .select()
    .from(memoryEmbedding)
    .where(and(inArray(memoryEmbedding.memoryId, memoryIds), eq(memoryEmbedding.status, "active")));
  // 同一 memoryId 可能有多条（不同 provider），取第一条（任意 provider）
  for (const row of rows) {
    if (!out.has(row.memoryId)) {
      out.set(row.memoryId, row);
    }
  }
  return out;
}

/**
 * 清理过期记忆。物理删除 expiresAt < now 的 active 记忆（含其 embedding 行）。
 * 由 retention 定时任务调用。@returns 删除条数
 */
export async function cleanupExpiredMemories(): Promise<number> {
  const now = new Date();
  const expired = await db
    .select({ id: memoryEntry.id })
    .from(memoryEntry)
    .where(and(lt(memoryEntry.expiresAt, now), eq(memoryEntry.status, "active")));
  if (expired.length === 0) return 0;
  const ids = expired.map((r) => r.id);
  // 事务化删除：embeddings + entries 要么一起成功要么一起回滚，防半删导致语义搜索失效
  return db.transaction(async (tx) => {
    await tx.delete(memoryEmbedding).where(inArray(memoryEmbedding.memoryId, ids));
    const result = await tx.delete(memoryEntry).where(inArray(memoryEntry.id, ids));
    return (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
  });
}

/**
 * 清理超期 ContextSnapshot（全 thread，不限终态）。
 * 原仅 retention 清终态 thread 的 snapshot；活跃 thread 的旧 snapshot 无限累积。
 * 本函数删 createdAt < cutoff 的 snapshot，由 retention 定时任务调用。
 *
 * 默认 retainDays 取自 dbConfig.snapshotRetentionDays（独立短保留期，默认 7 天），
 * 区别于全局 retentionDays（90 天）。其他表仍用全局保留期。
 */
export async function cleanupOldSnapshots(retainDays?: number): Promise<number> {
  const days = retainDays ?? dbConfig.snapshotRetentionDays;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await db.delete(contextSnapshot).where(lt(contextSnapshot.createdAt, cutoff));
  return (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
}

/**
 * seed 版本追踪（幂等标记）。
 * 用 policyConfig 表 key="seed_version" 存储，避免新表。seed.ts 执行前检查版本，已执行则跳过。
 */
export async function getSeedVersion(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(policyConfig)
    .where(eq(policyConfig.key, "seed_version"))
    .limit(1);
  return (row?.value as string) ?? null;
}

export async function setSeedVersion(version: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(policyConfig)
    .where(eq(policyConfig.key, "seed_version"))
    .limit(1);
  if (existing) {
    await db
      .update(policyConfig)
      .set({ value: version })
      .where(eq(policyConfig.key, "seed_version"));
  } else {
    await db.insert(policyConfig).values({ key: "seed_version", value: version });
  }
}

/**
 * 列某 memory 的全部 embedding 行（不分 provider/status）。
 * 供 markEmbeddingStale（标 stale 需先读现有行）与 Studio 诊断。
 */
export async function listEmbeddingRowsByMemory(memoryId: string): Promise<MemoryEmbedding[]> {
  return db.select().from(memoryEmbedding).where(eq(memoryEmbedding.memoryId, memoryId));
}

// ─── MCP Server Config Queries () ───────────────────────
//
// McpServerConfig CRUD。env 字段含 secret，调用方（Studio API / registry）负责脱敏后返回，
// 调用时注入真实 env——本层只做纯 DB 操作，不做脱敏。权限走 ToolPermissionRule（mcp.<name>.<tool>）。

export async function createMcpServerConfig(params: {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  env?: Record<string, string> | null;
  allowedTools?: string[] | null;
  enabled?: boolean;
}): Promise<McpServerConfig> {
  const row: McpServerConfig = {
    id: randomUUID(),
    name: params.name,
    transport: params.transport,
    command: params.command ?? null,
    args: params.args ?? null,
    url: params.url ?? null,
    env: params.env ?? null,
    allowedTools: params.allowedTools ?? null,
    enabled: params.enabled ?? true,
    // 协商字段建时为 null,连接成功后 recordMcpServerHandshake 回写
    lastServerVersion: null,
    lastCapabilities: null,
    lastConnectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(mcpServerConfig).values(row);
  return row;
}

export async function getMcpServerConfig(id: string): Promise<McpServerConfig | null> {
  const [row] = await db.select().from(mcpServerConfig).where(eq(mcpServerConfig.id, id)).limit(1);
  return row ?? null;
}

export async function getMcpServerConfigByName(name: string): Promise<McpServerConfig | null> {
  const [row] = await db
    .select()
    .from(mcpServerConfig)
    .where(eq(mcpServerConfig.name, name))
    .limit(1);
  return row ?? null;
}

export async function listMcpServerConfigs(): Promise<McpServerConfig[]> {
  return db.select().from(mcpServerConfig).orderBy(asc(mcpServerConfig.createdAt));
}

export async function listEnabledMcpServerConfigs(): Promise<McpServerConfig[]> {
  return db
    .select()
    .from(mcpServerConfig)
    .where(eq(mcpServerConfig.enabled, true))
    .orderBy(asc(mcpServerConfig.createdAt));
}

export async function updateMcpServerConfig(
  id: string,
  patch: {
    name?: string;
    transport?: "stdio" | "http" | "sse";
    command?: string | null;
    args?: string[] | null;
    url?: string | null;
    env?: Record<string, string> | null;
    allowedTools?: string[] | null;
    enabled?: boolean;
  },
): Promise<McpServerConfig | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[k] = v;
  }
  await db.update(mcpServerConfig).set(set).where(eq(mcpServerConfig.id, id));
  const [row] = await db.select().from(mcpServerConfig).where(eq(mcpServerConfig.id, id)).limit(1);
  return row ?? null;
}

export async function deleteMcpServerConfig(id: string): Promise<void> {
  await db.delete(mcpServerConfig).where(eq(mcpServerConfig.id, id));
}

/**
 * 记录 MCP server 连接协商结果(server 版本 + 能力)到 DB。
 *
 * 连接成功后 best-effort 回写 lastServerVersion/lastCapabilities/lastConnectedAt,
 * 供审计 server 兼容性(原仅落日志,日志轮转丢失不可追溯)。
 * 按 name 定位(server name 唯一);best-effort——失败仅记日志不阻断连接。
 */
export async function recordMcpServerHandshake(
  serverName: string,
  info: { serverVersion?: string | null; capabilities?: Record<string, unknown> | null },
): Promise<void> {
  await db
    .update(mcpServerConfig)
    .set({
      lastServerVersion: info.serverVersion ?? null,
      lastCapabilities: info.capabilities ?? null,
      lastConnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mcpServerConfig.name, serverName));
}

// ─── Custom Tool Queries () ──────────────────────────────
//
// CustomTool CRUD。executorConfig.webhook 走域名 allowlist（SSRF 防护在 registry 层）；
// executorConfig.script.scriptId 必须在平台预置白名单（registry 层校验，DB 不校验）。
// 权限走 ToolPermissionRule（custom.<name>，默认 ask）。

export async function createCustomTool(params: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executorType: "webhook" | "script";
  executorConfig: Record<string, unknown>;
  enabled?: boolean;
}): Promise<CustomTool> {
  // json 列 zod 校验（fail-closed，脏数据抛错不落库）
  const inputSchema = validateJsonColumn(
    params.inputSchema,
    customToolInputSchemaSchema,
    "inputSchema",
  );
  const executorConfig = validateJsonColumn(
    params.executorConfig,
    customToolExecutorConfigSchema,
    "executorConfig",
  );
  const row: CustomTool = {
    id: randomUUID(),
    name: params.name,
    description: params.description,
    inputSchema,
    executorType: params.executorType,
    executorConfig,
    enabled: params.enabled ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(customTool).values(row);
  return row;
}

export async function getCustomTool(id: string): Promise<CustomTool | null> {
  const [row] = await db.select().from(customTool).where(eq(customTool.id, id)).limit(1);
  return row ?? null;
}

export async function getCustomToolByName(name: string): Promise<CustomTool | null> {
  const [row] = await db.select().from(customTool).where(eq(customTool.name, name)).limit(1);
  return row ?? null;
}

export async function listCustomTools(): Promise<CustomTool[]> {
  return db.select().from(customTool).orderBy(asc(customTool.createdAt));
}

export async function listEnabledCustomTools(): Promise<CustomTool[]> {
  return db
    .select()
    .from(customTool)
    .where(eq(customTool.enabled, true))
    .orderBy(asc(customTool.createdAt));
}

export async function updateCustomTool(
  id: string,
  patch: {
    name?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    executorType?: "webhook" | "script";
    executorConfig?: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<CustomTool | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[k] = v;
  }
  await db.update(customTool).set(set).where(eq(customTool.id, id));
  const [row] = await db.select().from(customTool).where(eq(customTool.id, id)).limit(1);
  return row ?? null;
}

export async function deleteCustomTool(id: string): Promise<void> {
  await db.delete(customTool).where(eq(customTool.id, id));
}

// ─── External Source 审计查询 () ────────────────────────
//
// external.fetched 事件复用 ThreadEvent payload（不单独建表，决策）。
// 列某 thread 最近的外部资料访问记录，供 Studio external 审计面板用。

export type ExternalFetchedEvent = {
  id: string;
  threadId: string;
  createdAt: Date;
  payload: {
    sourceUrl?: string;
    fetchedAt?: string;
    expiresAt?: string | null;
    contentHash?: string;
    artifactPath?: string;
    contentType?: string;
    bytes?: number;
    truncated?: boolean;
  };
};

export async function listExternalFetchedEvents(
  threadId: string,
  limit = 50,
): Promise<ExternalFetchedEvent[]> {
  const rows = await db
    .select()
    .from(threadEvent)
    .where(and(eq(threadEvent.threadId, threadId), eq(threadEvent.type, "external.fetched")))
    .orderBy(desc(threadEvent.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    threadId: r.threadId,
    createdAt: r.createdAt,
    payload: r.payload as ExternalFetchedEvent["payload"],
  }));
}

// ─── : SecretMount Queries ──────────────────────────────

/** 创建 secret mount（加密存储）。 */
export async function createSecretMount(params: {
  name: string;
  scope: SecretMountScope;
  scopeRef?: string | null;
  keyId: string;
  ciphertext: string;
}): Promise<SecretMount> {
  const now = new Date();
  const row: SecretMount = {
    id: randomUUID(),
    name: params.name,
    scope: params.scope,
    scopeRef: params.scopeRef ?? null,
    keyId: params.keyId,
    ciphertext: params.ciphertext,
    status: "active",
    createdAt: now,
    updatedAt: now,
    rotatedAt: null,
  };
  await db.insert(secretMount).values(row);
  return row;
}

/** 按 id 取 secret mount。 */
export async function getSecretMount(id: string): Promise<SecretMount | null> {
  const [row] = await db.select().from(secretMount).where(eq(secretMount.id, id)).limit(1);
  return row ?? null;
}

/** 列 scope 内 active 的 secret mount（按 name）。 */
export async function listActiveSecretsByScope(
  scope: SecretMountScope,
  scopeRef: string | null,
): Promise<SecretMount[]> {
  const conditions = [eq(secretMount.scope, scope), eq(secretMount.status, "active")];
  if (scopeRef !== null) {
    conditions.push(eq(secretMount.scopeRef, scopeRef));
  } else {
    conditions.push(isNull(secretMount.scopeRef));
  }
  return db
    .select()
    .from(secretMount)
    .where(and(...conditions))
    .orderBy(asc(secretMount.name));
}

/** 列 scope 内全部 secret mount（含 revoked，admin 管理用）。 */
export async function listSecretsByScope(
  scope: SecretMountScope,
  scopeRef: string | null,
): Promise<SecretMount[]> {
  const conditions = [eq(secretMount.scope, scope)];
  if (scopeRef !== null) {
    conditions.push(eq(secretMount.scopeRef, scopeRef));
  } else {
    conditions.push(isNull(secretMount.scopeRef));
  }
  return db
    .select()
    .from(secretMount)
    .where(and(...conditions))
    .orderBy(desc(secretMount.createdAt), desc(secretMount.id));
}

/** 轮换 secret：新密文覆盖 + rotatedAt 更新。 */
export async function rotateSecretMount(
  id: string,
  newCiphertext: string,
  keyId: string,
): Promise<SecretMount | null> {
  const now = new Date();
  await db
    .update(secretMount)
    .set({ ciphertext: newCiphertext, keyId, rotatedAt: now, updatedAt: now, status: "active" })
    .where(eq(secretMount.id, id));
  return getSecretMount(id);
}

/** 撤销 secret：status=revoked，停止注入。 */
export async function revokeSecretMount(id: string): Promise<SecretMount | null> {
  const now = new Date();
  await db
    .update(secretMount)
    .set({ status: "revoked", updatedAt: now })
    .where(eq(secretMount.id, id));
  return getSecretMount(id);
}

/** 删除 secret mount（物理删除，admin 操作）。 */
export async function deleteSecretMount(id: string): Promise<void> {
  await db.delete(secretMount).where(eq(secretMount.id, id));
}

// ─── : Deployment Queries ───────────────────────────────

/** 创建部署记录。 */
export async function createDeployment(params: {
  threadId: string;
  environment: string;
  commitSha?: string | null;
  imageTag?: string | null;
  artifactRef?: string | null;
  cicdJobId?: string | null;
  cicdJobUrl?: string | null;
  previousDeploymentId?: string | null;
}): Promise<Deployment> {
  const row: Deployment = {
    id: randomUUID(),
    threadId: params.threadId,
    environment: params.environment,
    commitSha: params.commitSha ?? null,
    imageTag: params.imageTag ?? null,
    artifactRef: params.artifactRef ?? null,
    cicdJobId: params.cicdJobId ?? null,
    cicdJobUrl: params.cicdJobUrl ?? null,
    status: "pending",
    previousDeploymentId: params.previousDeploymentId ?? null,
    deployedAt: null,
    rolledBackAt: null,
    errorMessage: null,
    createdAt: new Date(),
  };
  await db.insert(deployment).values(row);
  return row;
}

/**
 * : 原子占用 deploying 槽位。事务内 SELECT ... FOR UPDATE 锁 thread 行,
 * 再查同 thread 是否已有 deploying,无则 createDeployment。防 read-then-write 竞态:
 * 原列表查 deploying + createDeployment 分两步,并发双方都查到 0 个 → 各建一条 → 两次 CI/CD。
 * @returns { deployment } 占用成功;{ busy: true } 已有 deploying。
 */
export async function claimDeployingSlot(params: {
  threadId: string;
  environment: string;
  commitSha?: string | null;
  imageTag?: string | null;
  artifactRef?: string | null;
  previousDeploymentId?: string | null;
}): Promise<{ deployment: Deployment } | { busy: true }> {
  return db.transaction(async (tx) => {
    // 锁 thread 行,串行化同 thread 的并发 claim
    await tx
      .select({ id: thread.id })
      .from(thread)
      .where(eq(thread.id, params.threadId))
      .for("update");
    const existing = await tx
      .select({ id: deployment.id })
      .from(deployment)
      .where(and(eq(deployment.threadId, params.threadId), eq(deployment.status, "deploying")))
      .limit(1);
    if (existing.length > 0) return { busy: true as const };
    // P0-1: 直接 insert deploying(非 pending),使并发 claim 的 busy 检查命中。
    // FOR UPDATE 已锁 thread 行串行化,第二个 claim 进事务后查到 deploying→busy,
    // 杜绝并发部署触发两次 CI/CD(原 claim 插 pending 导致两个 claim 都过 busy 检查)。
    const row: Deployment = {
      id: randomUUID(),
      threadId: params.threadId,
      environment: params.environment,
      commitSha: params.commitSha ?? null,
      imageTag: params.imageTag ?? null,
      artifactRef: params.artifactRef ?? null,
      cicdJobId: null,
      cicdJobUrl: null,
      status: "deploying",
      previousDeploymentId: params.previousDeploymentId ?? null,
      deployedAt: null,
      rolledBackAt: null,
      errorMessage: null,
      createdAt: new Date(),
    };
    await tx.insert(deployment).values(row);
    return { deployment: row };
  });
}

/** 按 id 取部署记录。 */
export async function getDeployment(id: string): Promise<Deployment | null> {
  const [row] = await db.select().from(deployment).where(eq(deployment.id, id)).limit(1);
  return row ?? null;
}

/** 列 thread 的部署记录（按 createdAt desc）。 */
export async function listDeploymentsByThread(threadId: string): Promise<Deployment[]> {
  return db
    .select()
    .from(deployment)
    .where(eq(deployment.threadId, threadId))
    .orderBy(desc(deployment.createdAt));
}

/** 取 thread 最新一次成功部署。 */
export async function getLatestDeployedByThread(threadId: string): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployment)
    .where(and(eq(deployment.threadId, threadId), eq(deployment.status, "deployed")))
    .orderBy(desc(deployment.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * 列所有 deploying 状态的 deployment（跨 thread，供后台轮询）。
 */
export async function listDeployingDeployments(): Promise<Deployment[]> {
  return db.select().from(deployment).where(eq(deployment.status, "deploying"));
}

/** 更新部署状态与终态字段。 */
export async function updateDeployment(
  id: string,
  patch: {
    status?: DeploymentStatus;
    cicdJobId?: string | null;
    cicdJobUrl?: string | null;
    deployedAt?: Date | null;
    rolledBackAt?: Date | null;
    errorMessage?: string | null;
    artifactRef?: string | null;
  },
): Promise<Deployment | null> {
  const [existing] = await db.select().from(deployment).where(eq(deployment.id, id)).limit(1);
  if (!existing) return null;
  const sets: Record<string, unknown> = {};
  if (patch.status !== undefined) sets.status = patch.status;
  if (patch.cicdJobId !== undefined) sets.cicdJobId = patch.cicdJobId;
  if (patch.cicdJobUrl !== undefined) sets.cicdJobUrl = patch.cicdJobUrl;
  if (patch.deployedAt !== undefined) sets.deployedAt = patch.deployedAt;
  if (patch.rolledBackAt !== undefined) sets.rolledBackAt = patch.rolledBackAt;
  if (patch.errorMessage !== undefined) sets.errorMessage = patch.errorMessage;
  if (patch.artifactRef !== undefined) sets.artifactRef = patch.artifactRef;
  if (Object.keys(sets).length === 0) return existing;
  await db.update(deployment).set(sets).where(eq(deployment.id, id));
  return { ...existing, ...sets } as Deployment;
}
