ALTER TABLE `ExecutionBinding` DROP CONSTRAINT `ExecutionBinding_agentEvidence_all_or_nothing`;--> statement-breakpoint
DROP INDEX `ExecutionBinding_agentRevision_idx` ON `ExecutionBinding`;--> statement-breakpoint
ALTER TABLE `ThreadItem` MODIFY COLUMN `itemType` enum('user_message','user_guidance','assistant_message','tool_call','artifact','job_result','child_thread','user_action') NOT NULL;--> statement-breakpoint
ALTER TABLE `ThreadItem` MODIFY COLUMN `authorType` enum('user','assistant','system','tool') NOT NULL;--> statement-breakpoint
ALTER TABLE `RuntimeRevision` DROP COLUMN `agentContractSnapshotId`;--> statement-breakpoint
ALTER TABLE `RuntimeRevision` DROP COLUMN `verificationState`;--> statement-breakpoint
ALTER TABLE `RuntimeRevision` DROP COLUMN `evidenceDigest`;--> statement-breakpoint
ALTER TABLE `RuntimeRevision` DROP COLUMN `verifiedAt`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` DROP COLUMN `agentRevisionId`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` DROP COLUMN `agentContractSnapshotId`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` DROP COLUMN `agentContractDigest`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` DROP COLUMN `agentContextDigest`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` DROP COLUMN `agentPublicationRecordId`;--> statement-breakpoint
ALTER TABLE `RuntimeSessionBinding` DROP COLUMN `agentRevisionId`;