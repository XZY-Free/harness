/**
 * 品牌持久化查询：BrandSettings 单行文档与 BrandChangeAudit 只增审计。
 *
 * 写入必须在同一事务内完成「文档 upsert + revision 递增 + 审计落库」，
 * 保证 revision 与审计永不脱节；读取为单行主键查询，供 store 缓存与端点 ETag 使用。
 */
import { db } from "@/lib/db/client";
import { brandChangeAudit, brandSettings } from "@/lib/persistence/schema/branding";
import { eq } from "drizzle-orm";

export interface BrandRow {
  readonly document: Record<string, unknown>;
  readonly revision: number;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

export interface BrandWriteInput {
  readonly document: Record<string, unknown>;
  readonly revision: number;
  readonly revisionBefore: number;
  readonly patch: Record<string, unknown>;
  readonly actor: string | null;
  readonly now: Date;
}

export async function fetchBrandRow(): Promise<BrandRow | null> {
  const rows = await db.select().from(brandSettings).where(eq(brandSettings.id, 1)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    document: row.document,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export async function writeBrandRow(input: BrandWriteInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(brandSettings)
      .values({
        id: 1,
        document: input.document,
        revision: input.revision,
        updatedAt: input.now,
        updatedBy: input.actor,
      })
      .onDuplicateKeyUpdate({
        set: {
          document: input.document,
          revision: input.revision,
          updatedAt: input.now,
          updatedBy: input.actor,
        },
      });
    await tx.insert(brandChangeAudit).values({
      revisionBefore: input.revisionBefore,
      revisionAfter: input.revision,
      patch: input.patch,
      changedAt: input.now,
      changedBy: input.actor,
    });
  });
}
