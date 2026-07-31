CREATE TABLE `ThreadRunSkill` (
	`id` varchar(36) NOT NULL,
	`runId` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`skillId` varchar(36) NOT NULL,
	`skillVersionId` varchar(36) NOT NULL,
	`role` varchar(16) NOT NULL DEFAULT 'primary',
	`source` varchar(24) NOT NULL DEFAULT 'resolver',
	`reason` text,
	`contentHash` varchar(40),
	`createdAt` datetime NOT NULL,
	CONSTRAINT `ThreadRunSkill_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ThreadRunSkill` ADD CONSTRAINT `ThreadRunSkill_runId_ThreadRun_id_fk` FOREIGN KEY (`runId`) REFERENCES `ThreadRun`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ThreadRunSkill` ADD CONSTRAINT `ThreadRunSkill_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ThreadRunSkill_runId_idx` ON `ThreadRunSkill` (`runId`);--> statement-breakpoint
CREATE INDEX `ThreadRunSkill_threadId_createdAt_idx` ON `ThreadRunSkill` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ThreadRunSkill_skillId_skillVersionId_idx` ON `ThreadRunSkill` (`skillId`,`skillVersionId`);