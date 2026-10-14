import { dbConfig } from "@/lib/config";
import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit 配置（消费方模型 v4）。
 *
 * 19 张身份/授权/合规表的 DDL 与迁移归 auth-center 仓（其 drizzle/ 为权威），
 * nexharness 迁移只落 116 表。`tablesFilter` 排除这 19 张表：
 * - 排除表不生成 CREATE TABLE；其他表对它们的 REFERENCES 外键约束保留，
 *   建库时由 auth-center 迁移先行创建（外键前置）。
 * - 3 张 FK 目标 stub（Tenant / UserIdentity / PrincipalBinding）与过渡期余留表
 *   （UserExtensionAttribute / EnterpriseProfileSyncState / PermissionGroup /
 *   PermissionGroupMember / ResourceAccessPolicy / DeletionRequest / DeletionStep /
 *   RetentionPolicy / LegalHold）的 TS 定义仍在 schema 中（供本仓代码查询），
 *   但不参与迁移生成。
 */
export default defineConfig({
  schema: ["./lib/persistence/schema/index.ts"],
  out: "./drizzle",
  dialect: "mysql",
  tablesFilter: [
    "*",
    // identity（7）
    "!Tenant",
    "!UserIdentity",
    "!LocalCredential",
    "!AuthSession",
    "!UserExtensionAttribute",
    "!EnterpriseProfileSyncState",
    "!PrincipalBinding",
    // authorization（6）
    "!RoleActionBinding",
    "!PermissionRole",
    "!PermissionRoleAssignment",
    "!PermissionGroup",
    "!PermissionGroupMember",
    "!ResourceAccessPolicy",
    // 合规（6）
    "!DeletionRequest",
    "!DeletionStep",
    "!RetentionPolicy",
    "!LegalHold",
    "!SecurityIncident",
    "!IncidentContainment",
  ],
  dbCredentials: {
    url: dbConfig.url,
  },
});
