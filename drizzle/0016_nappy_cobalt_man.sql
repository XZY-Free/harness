CREATE TABLE `GitCheckpoint` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`tag` varchar(128) NOT NULL,
	`commitSha` varchar(64) NOT NULL,
	`reason` varchar(256) NOT NULL,
	`createdByToolRunId` varchar(36),
	`restoredAt` datetime,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `GitCheckpoint_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `GitCheckpoint` ADD CONSTRAINT `GitCheckpoint_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `GitCheckpoint_threadId_createdAt_idx` ON `GitCheckpoint` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `GitCheckpoint_threadId_tag_idx` ON `GitCheckpoint` (`threadId`,`tag`);