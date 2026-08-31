ALTER TABLE `AgentSessionBinding` DROP INDEX `AgentSessionBinding_revision_route_context_uq`;--> statement-breakpoint
ALTER TABLE `AgentSessionBinding` MODIFY COLUMN `threadId` varchar(36);--> statement-breakpoint
ALTER TABLE `AgentCall` ADD `agentSessionBindingId` varchar(36);--> statement-breakpoint
ALTER TABLE `AuditEvent` ADD `outcome` enum('succeeded','failed');--> statement-breakpoint
ALTER TABLE `AuditEvent` ADD `metadataRedacted` json;--> statement-breakpoint
ALTER TABLE `AgentSessionBinding` ADD CONSTRAINT `AgentSessionBinding_revision_route_context_uq` UNIQUE(`tenantId`,`agentRevisionId`,`routeRevisionId`,`externalContextRef`);--> statement-breakpoint
ALTER TABLE `AgentCall` ADD CONSTRAINT `AgentCall_agentSessionBindingId_AgentSessionBinding_id_fk` FOREIGN KEY (`agentSessionBindingId`) REFERENCES `AgentSessionBinding`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `AgentCall_session_binding_idx` ON `AgentCall` (`agentSessionBindingId`);--> statement-breakpoint
ALTER TABLE `AgentCallAttempt` DROP COLUMN `externalTaskRef`;--> statement-breakpoint
ALTER TABLE `AgentCall` DROP COLUMN `agentRevisionId`;--> statement-breakpoint
ALTER TABLE `AgentCall` DROP COLUMN `externalContextRef`;
