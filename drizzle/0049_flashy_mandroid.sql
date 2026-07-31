CREATE TABLE `SkillSyncMapping` (
	`id` varchar(36) NOT NULL,
	`source` varchar(32) NOT NULL DEFAULT 'capability-market',
	`remoteAssetId` varchar(128) NOT NULL,
	`remoteName` varchar(64),
	`remoteDisplayName` varchar(128),
	`remoteVersion` varchar(64),
	`remoteVersionId` varchar(128),
	`remoteContentHash` varchar(128),
	`localSkillId` varchar(36),
	`localSkillVersionId` varchar(36),
	`localName` varchar(64),
	`syncState` enum('active','blocked','hidden','not_found','name_conflict','error') NOT NULL DEFAULT 'active',
	`lastSyncedAt` datetime,
	`lastCheckedAt` datetime,
	`lastError` text,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `SkillSyncMapping_id` PRIMARY KEY(`id`),
	CONSTRAINT `SkillSyncMapping_remoteAssetId_uq` UNIQUE(`remoteAssetId`)
);
--> statement-breakpoint
ALTER TABLE `Skill` ADD `source` enum('local','capability-market') DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `SkillSyncMapping` ADD CONSTRAINT `SkillSyncMapping_localSkillId_Skill_id_fk` FOREIGN KEY (`localSkillId`) REFERENCES `Skill`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `SkillSyncMapping_localSkillId_idx` ON `SkillSyncMapping` (`localSkillId`);--> statement-breakpoint
CREATE INDEX `SkillSyncMapping_syncState_idx` ON `SkillSyncMapping` (`syncState`);