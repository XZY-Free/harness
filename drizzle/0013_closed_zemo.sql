CREATE TABLE `ToolApprovalRequest` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`toolRunId` varchar(36) NOT NULL,
	`toolName` varchar(64) NOT NULL,
	`permissionKey` varchar(128) NOT NULL,
	`argFingerprint` varchar(128) NOT NULL,
	`argSummary` varchar(512) NOT NULL,
	`status` enum('pending','approved','denied','expired','superseded') NOT NULL DEFAULT 'pending',
	`approvedScope` enum('once','thread','project','always'),
	`resolvedBy` varchar(36),
	`resolvedAt` datetime,
	`createdAt` datetime NOT NULL,
	`expiresAt` datetime,
	CONSTRAINT `ToolApprovalRequest_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ToolPermissionRule` (
	`id` varchar(36) NOT NULL,
	`scope` enum('global','tenant','project','thread','skill') NOT NULL DEFAULT 'global',
	`scopeRef` varchar(36),
	`toolPattern` varchar(128) NOT NULL,
	`argMatcher` json,
	`decision` enum('allow','deny','ask') NOT NULL,
	`reason` varchar(256),
	`priority` int NOT NULL DEFAULT 0,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `ToolPermissionRule_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ToolRun` MODIFY COLUMN `status` enum('running','succeeded','failed','awaiting_approval') NOT NULL DEFAULT 'running';--> statement-breakpoint
ALTER TABLE `ToolApprovalRequest` ADD CONSTRAINT `ToolApprovalRequest_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ToolApprovalRequest` ADD CONSTRAINT `ToolApprovalRequest_toolRunId_ToolRun_id_fk` FOREIGN KEY (`toolRunId`) REFERENCES `ToolRun`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ToolApprovalRequest` ADD CONSTRAINT `ToolApprovalRequest_resolvedBy_User_id_fk` FOREIGN KEY (`resolvedBy`) REFERENCES `User`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ToolApprovalRequest_threadId_status_idx` ON `ToolApprovalRequest` (`threadId`,`status`);--> statement-breakpoint
CREATE INDEX `ToolApprovalRequest_status_idx` ON `ToolApprovalRequest` (`status`);--> statement-breakpoint
CREATE INDEX `ToolPermissionRule_scope_scopeRef_idx` ON `ToolPermissionRule` (`scope`,`scopeRef`);--> statement-breakpoint
CREATE INDEX `ToolPermissionRule_toolPattern_idx` ON `ToolPermissionRule` (`toolPattern`);