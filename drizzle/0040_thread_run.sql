CREATE TABLE `ThreadRun` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'queued',
	`triggerType` varchar(32) NOT NULL DEFAULT 'user_message',
	`triggerMessageId` varchar(36),
	`model` varchar(128) NOT NULL,
	`skillId` varchar(36),
	`skillVersionId` varchar(36),
	`runtimeType` varchar(32),
	`startedAt` datetime,
	`finishedAt` datetime,
	`lastSeenAt` datetime,
	`cancelReason` text,
	`error` text,
	`promptTokens` int NOT NULL DEFAULT 0,
	`completionTokens` int NOT NULL DEFAULT 0,
	`totalTokens` int NOT NULL DEFAULT 0,
	`metadata` json,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `ThreadRun_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ThreadRun` ADD CONSTRAINT `ThreadRun_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ThreadRun_threadId_createdAt_idx` ON `ThreadRun` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ThreadRun_threadId_status_updatedAt_idx` ON `ThreadRun` (`threadId`,`status`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `ThreadRun_status_lastSeenAt_idx` ON `ThreadRun` (`status`,`lastSeenAt`);--> statement-breakpoint
CREATE INDEX `ThreadRun_triggerMessageId_idx` ON `ThreadRun` (`triggerMessageId`);