CREATE TABLE `ContextSummary` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`type` varchar(32) NOT NULL,
	`scope` json NOT NULL,
	`summaryText` text NOT NULL,
	`checksum` varchar(64) NOT NULL,
	`tokenEstimate` int NOT NULL,
	`originalTokenEstimate` int NOT NULL,
	`protectedRefs` json NOT NULL,
	`supersededById` varchar(36),
	`createdAt` datetime NOT NULL,
	CONSTRAINT `ContextSummary_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ContextSummary` ADD CONSTRAINT `ContextSummary_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ContextSummary_threadId_type_idx` ON `ContextSummary` (`threadId`,`type`);--> statement-breakpoint
CREATE INDEX `ContextSummary_threadId_checksum_idx` ON `ContextSummary` (`threadId`,`checksum`);--> statement-breakpoint
CREATE INDEX `ContextSummary_threadId_supersededById_idx` ON `ContextSummary` (`threadId`,`supersededById`);