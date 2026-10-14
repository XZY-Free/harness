/**
 * 迁移基线后处理（消费方模型 v4）。
 *
 * drizzle-kit `generate` 不支持 tablesFilter（仅 push 支持）——因此对生成的迁移
 * SQL 做确定性后处理：从基线中移除全部"归 auth-center"表的 DDL。
 *
 * 处理规则：
 * - 19 张身份/授权/合规表：`CREATE TABLE` 块与其独立 `CREATE INDEX` 语句删除；
 *   其中 12 张（Tenant / UserIdentity / PrincipalBinding 等过渡表）的 TS 定义仍留在
 *   schema 中供本仓代码查询，但不在本仓迁移落 CREATE——建库时由 auth-center 迁移
 *   先行创建（外键前置）。
 * - 其他 116 张表对这些表的 `REFERENCES` 外键约束**保留**（不落 CREATE、外键保留）。
 *
 * 幂等：可重复执行；npm script 已在 db:generate 后自动串联。
 *
 * 已知边界（收尾轮注意）：meta/0000_snapshot.json 仍记录全部表定义——未来若从
 * TS schema 删除这些过渡表定义，diff 会生成 DROP TABLE；届时需同步裁剪 snapshot
 * （或在生成后将 DROP 语句一并移除）。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXCLUDED_TABLES = new Set<string>([
  // identity（7）
  "Tenant",
  "UserIdentity",
  "LocalCredential",
  "AuthSession",
  "UserExtensionAttribute",
  "EnterpriseProfileSyncState",
  "PrincipalBinding",
  // authorization（6）
  "RoleActionBinding",
  "PermissionRole",
  "PermissionRoleAssignment",
  "PermissionGroup",
  "PermissionGroupMember",
  "ResourceAccessPolicy",
  // 合规（6）
  "DeletionRequest",
  "DeletionStep",
  "RetentionPolicy",
  "LegalHold",
  "SecurityIncident",
  "IncidentContainment",
]);

const drizzleDir = join(process.cwd(), "drizzle");
const sqlFiles = readdirSync(drizzleDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

if (sqlFiles.length === 0) {
  console.error("[postprocess-drizzle] drizzle/ 下没有 .sql 文件");
  process.exit(1);
}

let totalRemoved = 0;

for (const file of sqlFiles) {
  const path = join(drizzleDir, file);
  const original = readFileSync(path, "utf8");
  const kept: string[] = [];
  let removed = 0;
  let skippingTable: string | null = null;
  let pendingBreakpointSkip = false;

  for (const line of original.split("\n")) {
    // 表块结束后的 `--> statement-breakpoint` 一并跳过（若有）。
    if (pendingBreakpointSkip) {
      pendingBreakpointSkip = false;
      if (line === "--> statement-breakpoint") continue;
    }
    // 跳过被排除表的 CREATE TABLE 块（至行首 `);` 为止）。
    if (skippingTable !== null) {
      if (line === ");") {
        skippingTable = null;
        pendingBreakpointSkip = true;
      }
      continue;
    }
    const createName = /^CREATE TABLE `([^`]+)` \($/.exec(line)?.[1];
    if (createName !== undefined && EXCLUDED_TABLES.has(createName)) {
      skippingTable = createName;
      removed += 1;
      continue;
    }
    const indexTable = /^CREATE (?:UNIQUE )?INDEX `[^`]+` ON `([^`]+)`/.exec(line)?.[1];
    if (indexTable !== undefined && EXCLUDED_TABLES.has(indexTable)) {
      removed += 1;
      continue;
    }
    // 被排除表主体的外键（ALTER TABLE 单行语句）：表不建，其约束一并不落。
    // 其他表 → REFERENCES 被排除表 的外键保留（外键前置，见文件头）。
    const alterTable = /^ALTER TABLE `([^`]+)` ADD CONSTRAINT/.exec(line)?.[1];
    if (alterTable !== undefined && EXCLUDED_TABLES.has(alterTable)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }

  if (removed > 0) {
    writeFileSync(path, kept.join("\n"), "utf8");
  }
  totalRemoved += removed;
  console.log(`[postprocess-drizzle] ${file}: 移除 ${removed} 个语句块`);
}

console.log(`[postprocess-drizzle] 完成，共移除 ${totalRemoved} 个语句块（116 表口径）`);
