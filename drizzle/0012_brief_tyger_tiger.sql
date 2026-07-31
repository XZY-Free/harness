CREATE TABLE `ContextSnapshot` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`trigger` varchar(64) NOT NULL,
	`model` varchar(128) NOT NULL,
	`runtimeType` varchar(32),
	`activeSkillVersionId` varchar(36),
	`toolNames` json NOT NULL,
	`layers` json NOT NULL,
	`protectedRefs` json NOT NULL,
	`excludedCandidates` json NOT NULL,
	`checksums` json NOT NULL,
	`estimatedTokens` int NOT NULL,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `ContextSnapshot_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ThreadPlan` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`title` varchar(256) NOT NULL,
	`status` enum('active','completed','abandoned') NOT NULL DEFAULT 'active',
	`source` varchar(32) NOT NULL DEFAULT 'system',
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `ThreadPlan_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ThreadPlanItem` (
	`id` varchar(36) NOT NULL,
	`planId` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`parentId` varchar(36),
	`position` int NOT NULL DEFAULT 0,
	`title` varchar(512) NOT NULL,
	`status` enum('pending','in_progress','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
	`evidence` json,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `ThreadPlanItem_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `Thread` MODIFY COLUMN `status` enum('idle','executing','ready_for_review','failed','planning','awaiting_input','awaiting_approval','verifying','delivering','completed','cancelled') NOT NULL DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE `ContextSnapshot` ADD CONSTRAINT `ContextSnapshot_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ThreadPlan` ADD CONSTRAINT `ThreadPlan_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ThreadPlanItem` ADD CONSTRAINT `ThreadPlanItem_planId_ThreadPlan_id_fk` FOREIGN KEY (`planId`) REFERENCES `ThreadPlan`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ThreadPlanItem` ADD CONSTRAINT `ThreadPlanItem_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ContextSnapshot_threadId_createdAt_idx` ON `ContextSnapshot` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ContextSnapshot_threadId_id_idx` ON `ContextSnapshot` (`threadId`,`id`);--> statement-breakpoint
CREATE INDEX `ThreadPlan_threadId_status_idx` ON `ThreadPlan` (`threadId`,`status`);--> statement-breakpoint
CREATE INDEX `ThreadPlanItem_threadId_position_idx` ON `ThreadPlanItem` (`threadId`,`position`);--> statement-breakpoint
CREATE INDEX `ThreadPlanItem_planId_position_idx` ON `ThreadPlanItem` (`planId`,`position`);