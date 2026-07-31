-- V11 Stage 12 S12-W03: ServiceLevelIndicator 增加 error_code 列
--
-- 事实源：lib/v11/schema/usage.ts、
--         ../v11-agentkit-platform/14-production-operations-security-and-retention.md §7.2（告警包含错误码）。
--
-- 关键约束：
-- - error_code 为可空列：非 breach 或无关联错误码时为 NULL。
-- - breach=true 时 error_code 填入触发的 V11 错误码（如 STREAM_BACKPRESSURE、EVENT_CURSOR_EXPIRED）。
-- - 不破坏现有数据：已有行 error_code 默认 NULL。
ALTER TABLE `v11_service_level_indicator`
  ADD COLUMN `error_code` varchar(64) NULL AFTER `alert_trace_id`;--> statement-breakpoint
ALTER TABLE `v11_service_level_indicator`
  ADD KEY `tenant_error_code_idx` (`tenant_id`, `error_code`);
