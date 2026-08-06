import { db } from "@/lib/db/client";
import { appendThreadEvent, updateThreadStatus } from "@/lib/db/queries";
import { thread } from "@/lib/db/schema";
import { and, eq, lt } from "drizzle-orm";

const DELIVERING_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

/**
 * M1-4: 扫描 delivering 状态超时的 thread，标记为 failed。
 * 防止 gitPush 成功后 deliverySummary 未调用导致永久悬空。
 */
export async function sweepStaleDeliveringThreads(): Promise<number> {
 const cutoff = new Date(Date.now() - DELIVERING_TIMEOUT_MS);

 const stale = await db
 .select({ id: thread.id })
 .from(thread)
 .where(and(eq(thread.status, "delivering"), lt(thread.updatedAt, cutoff)));

 for (const t of stale) {
 await updateThreadStatus(t.id, "failed");
 await appendThreadEvent(t.id, "agent.status_changed", {
 from: "delivering",
 to: "failed",
 reason: "delivering_timeout",
 });
 }

 return stale.length;
}
