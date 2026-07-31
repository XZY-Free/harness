CREATE TABLE `ThreadEvent` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`sequence` int NOT NULL,
	`type` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `ThreadEvent_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ToolRun` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`toolName` varchar(64) NOT NULL,
	`status` enum('running','succeeded','failed') NOT NULL DEFAULT 'running',
	`input` json NOT NULL,
	`output` json,
	`error` text,
	`startedAt` datetime NOT NULL,
	`finishedAt` datetime,
	CONSTRAINT `ToolRun_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ThreadEvent` ADD CONSTRAINT `ThreadEvent_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ToolRun` ADD CONSTRAINT `ToolRun_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;