ALTER TABLE `Thread` ADD `projectId` varchar(36);--> statement-breakpoint
CREATE INDEX `Thread_projectId_idx` ON `Thread` (`projectId`);