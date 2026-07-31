CREATE TABLE `AdminAuditLog` (
	`id` varchar(36) NOT NULL,
	`actorUserId` varchar(36) NOT NULL,
	`action` varchar(64) NOT NULL,
	`targetType` varchar(32) NOT NULL,
	`targetId` varchar(128) NOT NULL,
	`outcome` enum('succeeded','failed') NOT NULL,
	`metadata` json NOT NULL,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `AdminAuditLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `AdminAuditLog` ADD CONSTRAINT `AdminAuditLog_actorUserId_User_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `User`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `AdminAuditLog_createdAt_idx` ON `AdminAuditLog` (`createdAt`);--> statement-breakpoint
CREATE INDEX `AdminAuditLog_actorUserId_createdAt_idx` ON `AdminAuditLog` (`actorUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `AdminAuditLog_target_createdAt_idx` ON `AdminAuditLog` (`targetType`,`targetId`,`createdAt`);