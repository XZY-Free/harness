-- V11 Stage 11 S11-W08: V11AdminExport
--
-- 事实源：lib/v11/schema/admin-export.ts、
--         ../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W08。
--
-- 关键约束：
-- - 管理导出任务覆盖：audit_events/usage_records/cost_aggregates/capacity_snapshots/traces/evaluation_runs。
-- - 列表、筛选、分页和导出遵守租户/组织/Action Scope；导出同样脱敏并审计。
-- - redaction_summary 记录哪些字段被脱敏，便于审计与排障。
-- - 列名严格使用 snake_case（与 OpenAPI 契约一致）。
-- - 跨租户隔离：所有查询按 tenant_id 过滤；tenant_id 外键 → Tenant(id) ON DELETE CASCADE。
CREATE TABLE `v11_admin_export` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `requested_by` varchar(128) NOT NULL,
  `request_principal_kind` varchar(16) NOT NULL,
  `export_kind` varchar(32) NOT NULL,
  `filter_json` json NULL,
  `status` varchar(32) NOT NULL DEFAULT 'pending',
  `result_ref` varchar(512) NULL,
  `result_format` varchar(16) NOT NULL DEFAULT 'ndjson',
  `record_count` int NOT NULL DEFAULT 0,
  `redaction_summary` varchar(256) NULL,
  `failure_reason` varchar(256) NULL,
  `version_no` varchar(36) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `completed_at` datetime(3) NULL,
  PRIMARY KEY (`id`),
  KEY `tenant_status_idx` (`tenant_id`, `status`),
  KEY `tenant_kind_idx` (`tenant_id`, `export_kind`),
  KEY `tenant_requested_by_idx` (`tenant_id`, `requested_by`),
  CONSTRAINT `v11_admin_export_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
