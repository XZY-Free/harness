/**
 * : Schema 版本治理 — 集中管理所有 schema version 常量。
 *
 * 所有 Store 写入 Outbox 事件时引用此文件中的常量，
 * 不得各自硬编码 "1.0" 字符串。
 *
 * 版本升级规则：
 * - 新增字段（(optional/null) → minor 版本
 * - 删除字段或改(型(非兼容) → major 版本
 * - 迁移必须(在 drizzle/ 目录注册并有对应 journal entry
 */

/** Outbox 事件 Envelope schema 版本。 */
export const EVENT_SCHEMA_VERSION = "1.0" as const;

/** Route Eligibility Projection schema 版本。 */
export const PROJECTION_SCHEMA_VERSION = "1.0" as const;

/** ExecutionBinding configHash schema 版本。 */
export const BINDING_SCHEMA_VERSION = "1.0" as const;

/**
 * Schema 版本注册表 — 供架构门禁校验。
 * 新增 schema 版本时必须在此注册。
 */
export const SCHEMA_VERSIONS = {
  event: EVENT_SCHEMA_VERSION,
  projection: PROJECTION_SCHEMA_VERSION,
  binding: BINDING_SCHEMA_VERSION,
} as const;

export type SchemaName = keyof typeof SCHEMA_VERSIONS;
