-- V11 Stage 11 S11-W06: V11EvaluationRun / V11EvaluationCase / V11EvaluationResult
--
-- 事实源：lib/v11/schema/evaluation.ts、
--         ../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W06。
--
-- 关键约束：
-- - EvaluationRun 是评测运行根：明确绑定 AgentRevision、RuntimeRevision、Route、模型、数据集和评测策略。
-- - 评测执行使用独立 Job/Environment、真实持久数据和受控工具；不使用生产数据或生产 Credential。
-- - EvaluationCase 保留案例级证据：输入已脱敏、期望/实际结果、失败原因、版本引用。
-- - EvaluationResult 是结果投影：可比较指标（higher_better/lower_better/threshold），阈值按 Agent 风险配置。
-- - 列名严格使用 snake_case（与 OpenAPI 契约一致）。
-- - 跨租户隔离：所有查询按 tenant_id 过滤；tenant_id 外键 → Tenant(id) ON DELETE CASCADE。
CREATE TABLE `v11_evaluation_run` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `job_id` varchar(36) NULL,
  `agent_revision_id` varchar(36) NOT NULL,
  `runtime_revision_id` varchar(36) NULL,
  `route_id` varchar(36) NULL,
  `model_ref` varchar(128) NULL,
  `dataset_ref` varchar(256) NOT NULL,
  `strategy_key` varchar(64) NOT NULL,
  `run_state` varchar(32) NOT NULL DEFAULT 'queued',
  `threshold_config_json` json NULL,
  `summary_json` json NULL,
  `started_at` datetime(3) NULL,
  `finished_at` datetime(3) NULL,
  `created_by` varchar(36) NULL,
  `version_no` varchar(36) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_state_idx` (`tenant_id`, `run_state`),
  KEY `tenant_job_idx` (`tenant_id`, `job_id`),
  KEY `tenant_agent_revision_idx` (`tenant_id`, `agent_revision_id`),
  CONSTRAINT `v11_evaluation_run_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `v11_evaluation_run_job_id_fk` FOREIGN KEY (`job_id`) REFERENCES `V11Job` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `v11_evaluation_case` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `run_id` varchar(36) NOT NULL,
  `case_key` varchar(128) NOT NULL,
  `scenario_ref` varchar(256) NULL,
  `input_redacted_json` json NOT NULL,
  `expected_json` json NULL,
  `actual_redacted_json` json NULL,
  `case_state` varchar(32) NOT NULL DEFAULT 'pending',
  `failure_reason` varchar(256) NULL,
  `evidence_json` json NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_run_idx` (`tenant_id`, `run_id`),
  KEY `tenant_case_state_idx` (`tenant_id`, `case_state`),
  UNIQUE KEY `tenant_run_case_uq` (`tenant_id`, `run_id`, `case_key`),
  CONSTRAINT `v11_evaluation_case_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `v11_evaluation_case_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `v11_evaluation_run` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `v11_evaluation_result` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `run_id` varchar(36) NOT NULL,
  `case_id` varchar(36) NULL,
  `metric_key` varchar(64) NOT NULL,
  `metric_value` decimal(20, 6) NOT NULL,
  `comparator` varchar(32) NOT NULL DEFAULT 'higher_better',
  `threshold_value` decimal(20, 6) NULL,
  `passed` boolean NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tenant_run_idx` (`tenant_id`, `run_id`),
  KEY `tenant_case_idx` (`tenant_id`, `case_id`),
  KEY `tenant_metric_idx` (`tenant_id`, `metric_key`),
  CONSTRAINT `v11_evaluation_result_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `v11_evaluation_result_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `v11_evaluation_run` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `v11_evaluation_result_case_id_fk` FOREIGN KEY (`case_id`) REFERENCES `v11_evaluation_case` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;
