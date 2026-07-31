ALTER TABLE `ToolApprovalRequest` MODIFY COLUMN `approvedScope` enum('once','thread','project','always','session');--> statement-breakpoint
ALTER TABLE `Agent` ADD `deletedAt` datetime;--> statement-breakpoint
ALTER TABLE `Message` ADD `runId` varchar(36);--> statement-breakpoint
ALTER TABLE `Skill` ADD `deletedAt` datetime;