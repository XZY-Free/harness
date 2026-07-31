-- V11 Stage 11 S11-W05: V11Trace / V11Span / V11Observation
--
-- 事实源：lib/v11/schema/trace.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §11（Observability）、
--         ../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W05。
--
-- 关键约束：
-- - Trace 关联 invocation/job/thread 任一根类型，由 admin API 或未来 runtime 适配器写入（不扩展 Runtime ingress 协议）。
-- - Span 构成树形结构（parent_span_id 自引用），span_key 对应 W3C span_id。
-- - Observation 是已脱敏的观测记录，content_mode 决定可见内容深度。
-- - V11Observation.contains_secret 强制 false：写入前由 content-policy 脱敏，永不存储原始 secret。
-- - 列名严格使用 snake_case（与 OpenAPI 契约一致）。
-- - 跨租户隔离：所有查询按 tenant_id 过滤；tenant_id 外键 → Tenant(id) ON DELETE CASCADE。
CREATE TABLE `v11_trace` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `root_type` varchar(32) NOT NULL,
  `root_id` varchar(36) NOT NULL,
  `trace_key` varchar(128) NOT NULL,
  `root_span_id` varchar(36) NULL,
  `content_mode` varchar(32) NOT NULL DEFAULT 'metadata',
  `sampling_policy` varchar(32) NOT NULL DEFAULT 'always',
  `sampling_rate` json NULL,
  `trace_state` varchar(32) NOT NULL DEFAULT 'active',
  `started_at` datetime(3) NOT NULL,
  `finished_at` datetime(3) NULL,
  `attributes_json` json NULL,
  `version_no` varchar(36) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_root_idx` (`tenant_id`, `root_type`, `root_id`),
  KEY `tenant_trace_key_idx` (`tenant_id`, `trace_key`),
  KEY `tenant_state_idx` (`tenant_id`, `trace_state`),
  CONSTRAINT `v11_trace_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `v11_span` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `trace_id` varchar(36) NOT NULL,
  `parent_span_id` varchar(36) NULL,
  `span_key` varchar(36) NOT NULL,
  `name` varchar(256) NOT NULL,
  `kind` varchar(32) NOT NULL,
  `span_state` varchar(32) NOT NULL DEFAULT 'active',
  `started_at` datetime(3) NOT NULL,
  `finished_at` datetime(3) NULL,
  `attributes_json` json NULL,
  `events_json` json NULL,
  `version_no` varchar(36) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_trace_idx` (`tenant_id`, `trace_id`),
  KEY `tenant_parent_idx` (`tenant_id`, `parent_span_id`),
  KEY `tenant_kind_idx` (`tenant_id`, `kind`),
  CONSTRAINT `v11_span_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `v11_observation` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `trace_id` varchar(36) NOT NULL,
  `span_id` varchar(36) NULL,
  `invocation_id` varchar(36) NULL,
  `kind` varchar(32) NOT NULL,
  `content_mode` varchar(32) NOT NULL DEFAULT 'metadata',
  `content_json` json NULL,
  `contains_secret` json NOT NULL DEFAULT (false),
  `redaction_summary` varchar(256) NULL,
  `observed_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_trace_idx` (`tenant_id`, `trace_id`),
  KEY `tenant_span_idx` (`tenant_id`, `span_id`),
  KEY `tenant_invocation_idx` (`tenant_id`, `invocation_id`),
  KEY `tenant_kind_idx` (`tenant_id`, `kind`),
  CONSTRAINT `v11_observation_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
