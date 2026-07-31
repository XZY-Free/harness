-- V11 Stage 11 S11-W07: V11UsageRecord / V11CostAggregate / V11CapacitySnapshot / V11ServiceLevelIndicator
--
-- 事实源：lib/v11/schema/usage.ts、
--         ../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W07。
--
-- 关键约束：
-- - UsageRecord 是用量原子记录：dimension × scopeType × scopeRef 切分，bigint quantity/cost 序列化为 string。
-- - CostAggregate 按维度聚合投影：UNIQUE(tenant_id, dimension, scope_type, scope_ref, window_start, granularity) 防止重复聚合。
-- - CapacitySnapshot 区分调用量、并发、冷启动、积压、限额、故障，不只展示总 Token。
-- - ServiceLevelIndicator 是可执行阈值：breach=true 时告警，并能跳转相关 Invocation/Trace（不建设无来源的装饰仪表盘）。
-- - 列名严格使用 snake_case（与 OpenAPI 契约一致）。
-- - 跨租户隔离：所有查询按 tenant_id 过滤；tenant_id 外键 → Tenant(id) ON DELETE CASCADE。
CREATE TABLE `v11_usage_record` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `dimension` varchar(32) NOT NULL,
  `scope_type` varchar(32) NOT NULL,
  `scope_ref` varchar(128) NULL,
  `agent_revision_id` varchar(36) NULL,
  `model_ref` varchar(128) NULL,
  `tool_provider_id` varchar(36) NULL,
  `environment_id` varchar(36) NULL,
  `job_id` varchar(36) NULL,
  `invocation_id` varchar(36) NULL,
  `quantity` bigint NOT NULL,
  `unit_cost_micros` bigint NULL,
  `total_cost_micros` bigint NULL,
  `observed_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_dim_scope_idx` (`tenant_id`, `dimension`, `scope_type`),
  KEY `tenant_observed_idx` (`tenant_id`, `observed_at`),
  KEY `tenant_invocation_idx` (`tenant_id`, `invocation_id`),
  KEY `tenant_job_idx` (`tenant_id`, `job_id`),
  KEY `tenant_agent_revision_idx` (`tenant_id`, `agent_revision_id`),
  CONSTRAINT `v11_usage_record_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `v11_cost_aggregate` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `dimension` varchar(32) NOT NULL,
  `scope_type` varchar(32) NOT NULL,
  `scope_ref` varchar(128) NULL,
  `window_start` datetime(3) NOT NULL,
  `window_end` datetime(3) NOT NULL,
  `granularity` varchar(16) NOT NULL,
  `total_quantity` bigint NOT NULL,
  `total_cost_micros` bigint NOT NULL,
  `record_count` int NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_dim_scope_window_idx` (`tenant_id`, `dimension`, `scope_type`, `window_start`, `granularity`),
  UNIQUE KEY `tenant_dim_scope_window_granularity_uq` (`tenant_id`, `dimension`, `scope_type`, `scope_ref`, `window_start`, `granularity`),
  CONSTRAINT `v11_cost_aggregate_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `v11_capacity_snapshot` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `scope_type` varchar(32) NOT NULL,
  `scope_ref` varchar(128) NULL,
  `active_invocations` int NOT NULL DEFAULT 0,
  `queued_jobs` int NOT NULL DEFAULT 0,
  `cold_starts_last_hour` int NOT NULL DEFAULT 0,
  `limit_invocations_per_minute` int NULL,
  `limit_tokens_per_minute` bigint NULL,
  `limit_cost_per_hour_micros` bigint NULL,
  `failure_count_last_hour` int NOT NULL DEFAULT 0,
  `snapshot_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_scope_snapshot_idx` (`tenant_id`, `scope_type`, `scope_ref`, `snapshot_at`),
  CONSTRAINT `v11_capacity_snapshot_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `v11_service_level_indicator` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `scope_type` varchar(32) NOT NULL,
  `scope_ref` varchar(128) NULL,
  `indicator_key` varchar(64) NOT NULL,
  `indicator_value` decimal(20, 6) NOT NULL,
  `threshold_value` decimal(20, 6) NULL,
  `breach` boolean NOT NULL DEFAULT false,
  `alert_invocation_id` varchar(36) NULL,
  `alert_trace_id` varchar(36) NULL,
  `measured_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_scope_key_measured_idx` (`tenant_id`, `scope_type`, `indicator_key`, `measured_at`),
  KEY `tenant_breach_idx` (`tenant_id`, `breach`),
  CONSTRAINT `v11_service_level_indicator_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
