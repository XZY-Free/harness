#!/usr/bin/env tsx
/**
 * 已结束 thread 明细数据 TTL 清理 CLI 入口。
 *
 * 用法:
 * pnpm db:purge-retention # 按 dbConfig.retentionDays(默认 90 天)清理
 * SNOW_DB_RETENTION_DAYS=30 pnpm db:purge-retention # 30 天
 * SNOW_DB_RETENTION_DAYS=0 pnpm db:purge-retention # 0=禁用(不清理,仅打印)
 *
 * 清理范围:已结束(idle/ready_for_review/failed/cancelled/completed)且 updatedAt
 * 超过保留期的 thread 的明细(threadEvent/toolRun/contextSnapshot/contextSummary)。
 * thread 主记录保留。详见 lib/db/retention.ts。
 *
 * 破坏性操作:建议先 SNOW_DB_RETENTION_DAYS=0 确认,或小保留期试跑。
 */

import {
  cleanupExpiredMemories,
  cleanupOldSnapshots,
  cleanupSupersededSummaries,
} from "@/lib/db/queries";
import { purgeExpiredThreadDetails } from "@/lib/db/retention";
import { logger } from "@/lib/logger";

async function main() {
  const result = await purgeExpiredThreadDetails();
  if (result.skipped) {
    logger.info("[purge-retention] 跳过清理", { reason: result.reason });
    console.log("跳过清理:", result.reason);
  } else {
    logger.info("[purge-retention] 清理完成", result);
    console.log("清理完成:", JSON.stringify(result, null, 2));
  }
  // supersede 链 GC —— 物理删除 7 天前已 supersede 的旧 summary（全 thread）
  const supersededPurged = await cleanupSupersededSummaries().catch((err) => {
    logger.warn("[purge-retention] supersede GC 失败", { error: String(err) });
    return 0;
  });
  if (supersededPurged > 0) {
    logger.info("[purge-retention] supersede 链 GC 完成", { supersededPurged });
    console.log("supersede 链 GC 完成:", supersededPurged);
  }
  // 清理过期记忆（expiresAt < now）
  const memoryPurged = await cleanupExpiredMemories().catch((err) => {
    logger.warn("[purge-retention] 过期记忆清理失败", { error: String(err) });
    return 0;
  });
  if (memoryPurged > 0) {
    logger.info("[purge-retention] 过期记忆清理完成", { memoryPurged });
    console.log("过期记忆清理完成:", memoryPurged);
  }
  // 清理超期 ContextSnapshot（全 thread，不限终态）
  const snapshotPurged = await cleanupOldSnapshots().catch((err) => {
    logger.warn("[purge-retention] 旧 snapshot 清理失败", { error: String(err) });
    return 0;
  });
  if (snapshotPurged > 0) {
    logger.info("[purge-retention] 旧 snapshot 清理完成", { snapshotPurged });
    console.log("旧 snapshot 清理完成:", snapshotPurged);
  }
}

main().catch((err) => {
  logger.error("[purge-retention] 清理失败", { error: String(err) });
  console.error("清理失败:", err);
  process.exit(1);
});
