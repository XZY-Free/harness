CREATE TABLE `SkillSyncBinding` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`remoteAssetId` varchar(256) NOT NULL,
	`remoteName` varchar(128) NOT NULL,
	`remoteDisplayName` varchar(256),
	`remoteVersion` varchar(128) NOT NULL,
	`remoteVersionId` varchar(256),
	`remoteContentHash` varchar(256),
	`localSkillId` varchar(36) NOT NULL,
	`localSkillVersionId` varchar(36),
	`localName` varchar(128) NOT NULL,
	`syncState` varchar(32) NOT NULL DEFAULT 'active',
	`lastSyncedAt` datetime(3),
	`lastCheckedAt` datetime(3),
	`lastError` text,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `SkillSyncBinding_id` PRIMARY KEY(`id`),
	CONSTRAINT `SkillSyncBinding_tenant_remoteAssetId_uq` UNIQUE(`tenantId`,`remoteAssetId`)
);
--> statement-breakpoint
ALTER TABLE `SkillSyncBinding` ADD CONSTRAINT `SkillSyncBinding_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `SkillSyncBinding` ADD CONSTRAINT `SkillSyncBinding_localSkillId_Skill_id_fk` FOREIGN KEY (`localSkillId`) REFERENCES `Skill`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `SkillSyncBinding` ADD CONSTRAINT `SkillSyncBinding_localSkillVersionId_SkillVersion_id_fk` FOREIGN KEY (`localSkillVersionId`) REFERENCES `SkillVersion`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `SkillSyncBinding_tenant_localSkill_idx` ON `SkillSyncBinding` (`tenantId`,`localSkillId`);--> statement-breakpoint
CREATE INDEX `SkillSyncBinding_tenant_syncState_idx` ON `SkillSyncBinding` (`tenantId`,`syncState`);