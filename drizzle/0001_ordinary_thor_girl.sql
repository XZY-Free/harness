DROP INDEX `Thread_tenant_agent_activity_idx` ON `Thread`;--> statement-breakpoint
DROP INDEX `ThreadListProjection_tenant_agent_activity_idx` ON `ThreadListProjection`;--> statement-breakpoint
ALTER TABLE `Thread` DROP COLUMN `primaryAgentId`;--> statement-breakpoint
ALTER TABLE `ThreadListProjection` DROP COLUMN `primaryAgentId`;