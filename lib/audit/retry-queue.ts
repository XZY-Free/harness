import { db } from "@/lib/db/client";
import { auditFailureLog } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import { asc, eq } from "drizzle-orm";

/**
 * M1-3 + P1-11: 审计失败重试队列（G3）。
 *
 * 高危工具审计写入失败时，调用 recordAuditFailure 将失败记录(含完整审计入参)落库到
 * auditFailureLog 表。replayAuditFailures 由 instrumentation 定时调用,重放未消费的失败记录:
 * 重新调用 recordAdminAudit,成功则删除队列行;失败则保留待下次重试。
 */
export async function recordAuditFailure(params: {
  threadId: string;
  toolName: string;
  runId?: string;
  error: string;
  payload: unknown;
  timestamp: Date;
}) {
  try {
    await db.insert(auditFailureLog).values({
      threadId: params.threadId,
      toolName: params.toolName,
      runId: params.runId ?? null,
      errorMessage: params.error,
      payload: JSON.stringify(params.payload),
      createdAt: params.timestamp,
    });
  } catch (e) {
    // 审计失败记录本身也失败——CRITICAL 级别告警
    console.error("[audit] CRITICAL: failed to record audit failure:", e, params);
  }
}

/**
 * P1-11: 重放审计失败队列。扫描 auditFailureLog,逐条重试 recordAdminAudit,成功则删除。
 * 由 instrumentation 启动 + 定时调用,补齐"重试队列"的消费者(原只有入队无出队)。
 * @returns 成功重放的条数
 */
export async function replayAuditFailures(limit = 100): Promise<number> {
  // P1-7:orderBy createdAt 保证 FIFO,防积压超 limit 时旧失败记录饿死。
  const rows = await db
    .select()
    .from(auditFailureLog)
    .orderBy(asc(auditFailureLog.createdAt))
    .limit(limit);
  let replayed = 0;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload ?? "{}") as { auditInput?: unknown };
      if (!parsed.auditInput || typeof parsed.auditInput !== "object") {
        // 无 auditInput(旧格式或非重放型)→ 删除,无法重放
        await db.delete(auditFailureLog).where(eq(auditFailureLog.id, row.id));
        continue;
      }
      // P1-7:事务 + FOR UPDATE 原子消费——recordAdminAudit 与 delete 同事务,
      // 成功则一起提交,失败则一起回滚(行保留待下次)。多实例并发时,第二个实例的
      // SELECT FOR UPDATE 会等待,提交后行已删,返回空跳过,杜绝重复重放落库。
      await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(auditFailureLog)
          .where(eq(auditFailureLog.id, row.id))
          .for("update")
          .limit(1);
        if (!locked) return; // 已被其他实例删除
        await recordAdminAudit(parsed.auditInput as Parameters<typeof recordAdminAudit>[0], tx);
        await tx.delete(auditFailureLog).where(eq(auditFailureLog.id, row.id));
        replayed++;
      });
    } catch (err) {
      // P2-10: 重放失败 increment retryCount,超限(10)删除(死信),防毒丸永久重试 + FIFO 饿死后续
      const newRetryCount = (row.retryCount ?? 0) + 1;
      if (newRetryCount >= 10) {
        await db.delete(auditFailureLog).where(eq(auditFailureLog.id, row.id));
        logger.warn("[audit] 重放重试超限,移死信删除", {
          id: row.id,
          retryCount: newRetryCount,
          toolName: row.toolName,
        });
      } else {
        await db
          .update(auditFailureLog)
          .set({ retryCount: newRetryCount })
          .where(eq(auditFailureLog.id, row.id));
        logger.warn("[audit] 重放审计失败行仍失败,保留待下次", {
          id: row.id,
          retryCount: newRetryCount,
          toolName: row.toolName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return replayed;
}
