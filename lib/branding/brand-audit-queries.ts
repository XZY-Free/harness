/**
 * 品牌变更审计读取：BrandChangeAudit 的生产 reader。
 *
 * 审计只增不改；本模块提供按 revision 倒序的受限读取，供管理端品牌页
 * 与运维回溯使用。写入口唯一为 brand-queries.writeBrandRow 事务。
 */
import { db } from "@/lib/db/client";
import { brandChangeAudit } from "@/lib/persistence/schema/branding";
import { desc } from "drizzle-orm";

export interface BrandChangeAuditEntry {
  readonly id: number;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly patch: Record<string, unknown>;
  readonly changedAt: Date;
  readonly changedBy: string | null;
}

export async function listBrandChangeAudit(limit = 50): Promise<BrandChangeAuditEntry[]> {
  const rows = await db
    .select()
    .from(brandChangeAudit)
    .orderBy(desc(brandChangeAudit.revisionAfter))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows;
}
