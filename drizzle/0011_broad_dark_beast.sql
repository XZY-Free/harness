ALTER TABLE `SkillVersion` MODIFY COLUMN `promptTemplate` text;--> statement-breakpoint
ALTER TABLE `SkillVersion` ADD `commitSha` varchar(40);