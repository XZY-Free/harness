import { db } from "@/lib/db/client";
import { type PolicyConfigRow, policyConfig } from "@/lib/db/schema";
import { asc } from "drizzle-orm";

/**
 * ：Agent Studio 后台只读 / 聚合查询。
 *
 * 与 `lib/db/queries.ts`（单 thread CRUD + 写函数）分离：studio 是跨 thread / 跨 skill 的
 * 后台视角，索引诉求与语义不同，独立目录便于单测与后续切片复用。
 *
 * 02-4 迁移：skill 相关查询（listSkills / listSkillVersions / listSkillsWithSync /
 * getSkillSyncInfo）已迁到正式 `lib/capability/skill-studio-queries.ts`（tenant-scoped）。
 * 本文件仅保留 policy 只读展示查询（policy 域由 02-6 承接）。
 */

// ─── Policy（Stage E，只读展示） ─────────────────────────────

/** 列 PolicyConfig 全部行（key → JSON value），按 key 升序。 */
export async function getPolicyConfigRows(): Promise<PolicyConfigRow[]> {
  return db.select().from(policyConfig).orderBy(asc(policyConfig.key));
}
