import { dbConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { deleteThreadRecursive } from "@/lib/db/queries";
import {
 type ThreadStatus,
 contextSnapshot,
 contextSummary,
 message,
 runTranscriptChunk,
 thread,
 threadEvent,
 threadRun,
 threadRunSkill,
 toolRun,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { and, inArray, isNotNull, lt } from "drizzle-orm";

/**
 * retention 明细清理子集。
 *
 * 与 deleteThreadRecursive 的 THREAD_CHILD_TABLES 对齐,但 retention 默认只清明细、
 * 保留 thread 主记录与审批/交付历史(threadApprovalRequest/backgroundTask/gitCheckpoint/
 * subagentRun/deployment 等)。
 * : 扩展到全部执行过程明细——原 5 张(threadEvent/toolRun/contextSnapshot/
 * contextSummary/runTranscriptChunk)+ threadRun/threadRunSkill/message。清理执行过程
 * 只影响回放,不影响历史列表与交付审计。按 FK 依赖顺序排列(串行删):threadRunSkill +
 * runTranscriptChunk 引用 threadRun,先于 threadRun 删。
 */
const RETENTION_DETAIL_TABLES = [
 threadRunSkill,
 runTranscriptChunk,
 threadRun,
 message,
 threadEvent,
 toolRun,
 contextSnapshot,
 contextSummary,
] as const;

/**
 * 已结束 thread 明细数据 TTL 清理。
 *
 * threadEvent append-only、toolRun 永久保留,长周期运行后表膨胀查询变慢。
 * 本模块提供 purgeExpiredThreadDetails:清理"已结束状态 + updatedAt 超过保留期"
 * 的 thread 的明细数据,保留 thread 主记录(历史列表仍可见)。
 *
 * 设计取舍:
 * - 只清明细(threadEvent/toolRun/contextSnapshot/contextSummary),保留 thread 主记录
 * —— 历史会话列表/交付记录/审批历史仍可查,只丢执行过程明细
 * - 只清"已结束"状态(idle/ready_for_review/failed/cancelled/completed),
 * 绝不清活跃态(executing/planning/awaiting_input/awaiting_approval/verifying/delivering)——防误清运行中数据
 * - 按 updatedAt 判定超期(非 createdAt):活跃 thread 即便很老也不清(updatedAt 持续刷新)
 * - 不自动跑:由 API/脚本显式触发(避免误删);retentionDays=0 禁用
 *
 * 清理是破坏性操作,调用方须明确知情。返回各表删除条数供审计。
 */

/** 已结束的 thread 状态(可安全清理明细)。活跃态绝不在此列。 */
const TERMINAL_STATUSES: ThreadStatus[] = [
 "idle",
 "ready_for_review",
 "failed",
 "cancelled",
 "completed",
];

export type PurgeResult = {
 purgedThreads: number;
 threadRunSkills: number;
 runTranscriptChunks: number;
 threadRuns: number;
 messages: number;
 threadEvents: number;
 toolRuns: number;
 contextSnapshots: number;
 contextSummaries: number;
 /** :物理删除主记录条数(软删超 hardDeleteRetentionDays 的 thread)。 */
 hardDeletedThreads: number;
 skipped: boolean;
 reason?: string;
};

/**
 * 清理已结束且超过保留期的 thread 明细数据。
 *
 * @param retentionDaysOverride 覆盖 dbConfig.retentionDays(测试用);不传用配置
 * @returns 各表删除条数;retentionDays=0 时 skipped=true 不执行
 */
export async function purgeExpiredThreadDetails(
 retentionDaysOverride?: number,
): Promise<PurgeResult> {
 const retentionDays = retentionDaysOverride ?? dbConfig.retentionDays;
 if (retentionDays <= 0) {
 return {
 purgedThreads: 0,
 threadRunSkills: 0,
 runTranscriptChunks: 0,
 threadRuns: 0,
 messages: 0,
 threadEvents: 0,
 toolRuns: 0,
 contextSnapshots: 0,
 contextSummaries: 0,
 hardDeletedThreads: 0,
 skipped: true,
 reason: `retentionDays=${retentionDays}(禁用清理)`,
 };
 }

 const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

 // 找出已结束 + updatedAt 超期的 thread(明细清理目标)
 const expired = await db
 .select({ id: thread.id })
 .from(thread)
 .where(and(inArray(thread.status, TERMINAL_STATUSES), lt(thread.updatedAt, cutoff)));

 if (expired.length === 0) {
 return {
 purgedThreads: 0,
 threadRunSkills: 0,
 runTranscriptChunks: 0,
 threadRuns: 0,
 messages: 0,
 threadEvents: 0,
 toolRuns: 0,
 contextSnapshots: 0,
 contextSummaries: 0,
 hardDeletedThreads: 0,
 skipped: false,
 };
 }

 const threadIds = expired.map((t) => t.id);

 // :明细按表删除,复用 RETENTION_DETAIL_TABLES 与 deleteThreadRecursive 对齐,防漏表。
 // 不删 thread 主记录(保留历史列表);不删 toolApprovalRequest/backgroundTask/gitCheckpoint(交付/审批历史)。
 // 修复：用事务包裹并行删除，防止部分表删除成功/部分失败导致数据不一致。
 // drizzle MySQL delete 返回 MySqlRawQueryResult(类型上无 rowsAffected),
 // 运行时为 mysql2 ResultSetHeader,真实字段是 affectedRows。用类型断言取,取不到回退 0。
 const affectedRows = (r: unknown): number => {
 const header = r as { affectedRows?: unknown } | unknown[];
 if (Array.isArray(header) && header[0] && typeof header[0] === "object") {
 const n = (header[0] as { affectedRows?: unknown }).affectedRows;
 return typeof n === "number" ? n : 0;
 }
 if (header && typeof header === "object" && "affectedRows" in header) {
 const n = header.affectedRows;
 return typeof n === "number" ? n : 0;
 }
 return 0;
 };
 // : 串行删除(按 FK 依赖顺序),防 threadRunSkill/runTranscriptChunk 引用 threadRun 时并行删触发 FK 违反
 const deleted: unknown[] = [];
 await db.transaction(async (tx) => {
 for (const t of RETENTION_DETAIL_TABLES) {
 deleted.push(await tx.delete(t).where(inArray(t.threadId, threadIds)));
 }
 });
 // 清理终态 thread 的 QA 证据文件（截图/报告 JSON）
 const { cleanupQaArtifacts } = await import("@/lib/qa/artifact");
 await Promise.all(threadIds.map((tid) => cleanupQaArtifacts(tid).catch(() => {})));

 // :物理删软删超期主记录(可配,默认关)。
 // 形成软删→(hardDeleteRetentionDays)→物理删闭环;默认 0 禁用,主记录永久保留。
 const hardDeleteDays = dbConfig.hardDeleteRetentionDays;
 let hardDeletedThreads = 0;
 if (hardDeleteDays > 0) {
 const hardCutoff = new Date(Date.now() - hardDeleteDays * 24 * 60 * 60 * 1000);
 const softDeleted = await db
 .select({ id: thread.id })
 .from(thread)
 .where(and(isNotNull(thread.deletedAt), lt(thread.deletedAt, hardCutoff)));
 // 逐条事务删除(deleteThreadRecursive 内部按依赖序删子表+主记录)。
 // 不并发——物理删除是重操作,串行更可控,且避免事务嵌套/锁竞争。
 for (const t of softDeleted) {
 try {
 await deleteThreadRecursive(t.id);
 hardDeletedThreads += 1;
 } catch (err) {
 logger.warn("[retention] 物理删除 thread 失败,跳过", {
 threadId: t.id,
 error: err instanceof Error ? err.message : String(err),
 });
 }
 }
 }

 const [runSkillsDel, chunksDel, runsDel, messagesDel, eventsDel, toolsDel, snapsDel, sumsDel] =
 deleted;
 const result: PurgeResult = {
 purgedThreads: threadIds.length,
 threadRunSkills: affectedRows(runSkillsDel),
 runTranscriptChunks: affectedRows(chunksDel),
 threadRuns: affectedRows(runsDel),
 messages: affectedRows(messagesDel),
 threadEvents: affectedRows(eventsDel),
 toolRuns: affectedRows(toolsDel),
 contextSnapshots: affectedRows(snapsDel),
 contextSummaries: affectedRows(sumsDel),
 hardDeletedThreads,
 skipped: false,
 };

 logger.info("[retention] 清理已结束超期 thread 明细", {
 retentionDays,
 cutoff: cutoff.toISOString(),
 hardDeleteDays,
 ...result,
 });

 return result;
}
