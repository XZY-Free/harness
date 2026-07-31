CREATE TABLE `SubagentDefinition` (
	`id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`role` enum('explore','researcher','reviewer','verifier','executor') NOT NULL,
	`modelProfileId` varchar(36),
	`allowedTools` json NOT NULL,
	`contextPolicy` json NOT NULL,
	`outputSchema` json,
	`defaultWriteScope` json,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `SubagentDefinition_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `SubagentRun` (
	`id` varchar(36) NOT NULL,
	`parentThreadId` varchar(36) NOT NULL,
	`definitionId` varchar(36) NOT NULL,
	`goal` text NOT NULL,
	`status` enum('queued','running','completed','failed','cancelled','timed_out') NOT NULL DEFAULT 'queued',
	`writeScope` json,
	`resultSummary` text,
	`outputArtifactId` varchar(36),
	`transcriptPath` varchar(512),
	`errorMessage` text,
	`startedAt` datetime,
	`finishedAt` datetime,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `SubagentRun_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `SubagentRun` ADD CONSTRAINT `SubagentRun_parentThreadId_Thread_id_fk` FOREIGN KEY (`parentThreadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `SubagentRun` ADD CONSTRAINT `SubagentRun_definitionId_SubagentDefinition_id_fk` FOREIGN KEY (`definitionId`) REFERENCES `SubagentDefinition`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `SubagentDefinition_name_idx` ON `SubagentDefinition` (`name`);--> statement-breakpoint
CREATE INDEX `SubagentDefinition_role_idx` ON `SubagentDefinition` (`role`);--> statement-breakpoint
CREATE INDEX `SubagentRun_parentThreadId_status_idx` ON `SubagentRun` (`parentThreadId`,`status`);--> statement-breakpoint
CREATE INDEX `SubagentRun_definitionId_idx` ON `SubagentRun` (`definitionId`);