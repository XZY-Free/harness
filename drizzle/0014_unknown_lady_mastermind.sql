CREATE TABLE `BackgroundTask` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`toolRunId` varchar(36),
	`kind` varchar(32) NOT NULL,
	`command` varchar(1024) NOT NULL,
	`runtimeType` varchar(32) NOT NULL,
	`status` enum('starting','running','stopped','failed','cancelled','orphaned') NOT NULL DEFAULT 'starting',
	`pid` int,
	`containerName` varchar(128),
	`port` int,
	`logPath` varchar(512) NOT NULL,
	`exitCode` int,
	`startedAt` datetime NOT NULL,
	`finishedAt` datetime,
	`lastActivityAt` datetime NOT NULL,
	CONSTRAINT `BackgroundTask_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `BackgroundTask` ADD CONSTRAINT `BackgroundTask_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `BackgroundTask_threadId_status_idx` ON `BackgroundTask` (`threadId`,`status`);--> statement-breakpoint
CREATE INDEX `BackgroundTask_status_idx` ON `BackgroundTask` (`status`);--> statement-breakpoint
CREATE INDEX `BackgroundTask_threadId_lastActivityAt_idx` ON `BackgroundTask` (`threadId`,`lastActivityAt`);