ALTER TABLE `GitCheckpoint` ADD `filesChanged` text;--> statement-breakpoint
ALTER TABLE `Skill` ADD `ownerUserId` varchar(36);--> statement-breakpoint
ALTER TABLE `Thread` DROP COLUMN `titleUpdatedAt`;