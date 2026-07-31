CREATE TABLE `AuditFailureLog` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`toolName` varchar(128) NOT NULL,
	`runId` varchar(36),
	`errorMessage` text NOT NULL,
	`payload` text,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `AuditFailureLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `AuditFailureLog_threadId_createdAt_idx` ON `AuditFailureLog` (`threadId`,`createdAt`);