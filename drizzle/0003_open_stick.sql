CREATE TABLE `Skill` (
	`id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`description` text,
	`category` varchar(64),
	`visibility` varchar(32) NOT NULL DEFAULT 'public',
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`currentVersionId` varchar(36),
	`createdAt` datetime NOT NULL,
	CONSTRAINT `Skill_id` PRIMARY KEY(`id`),
	CONSTRAINT `Skill_name_uq` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `SkillVersion` (
	`id` varchar(36) NOT NULL,
	`skillId` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`promptTemplate` text NOT NULL,
	`allowedTools` json,
	`defaultModelProfile` varchar(128),
	`completionCriteria` json,
	`reviewMode` varchar(32) NOT NULL DEFAULT 'auto',
	`artifactPolicy` json,
	`status` enum('draft','active','archived') NOT NULL DEFAULT 'active',
	`createdAt` datetime NOT NULL,
	CONSTRAINT `SkillVersion_id` PRIMARY KEY(`id`),
	CONSTRAINT `SkillVersion_skillId_version_uq` UNIQUE(`skillId`,`version`)
);
--> statement-breakpoint
ALTER TABLE `Thread` ADD `activeSkillVersionId` varchar(36);--> statement-breakpoint
ALTER TABLE `SkillVersion` ADD CONSTRAINT `SkillVersion_skillId_Skill_id_fk` FOREIGN KEY (`skillId`) REFERENCES `Skill`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `SkillVersion_skillId_status_idx` ON `SkillVersion` (`skillId`,`status`);