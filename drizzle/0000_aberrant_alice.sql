CREATE TABLE `Message` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`role` varchar(32) NOT NULL,
	`type` varchar(32),
	`parts` json NOT NULL,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `Message_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `Thread` (
	`id` varchar(36) NOT NULL,
	`createdAt` datetime NOT NULL,
	`title` text NOT NULL,
	`userId` varchar(36) NOT NULL,
	`status` enum('idle','executing','ready_for_review','failed') NOT NULL DEFAULT 'idle',
	`model` varchar(64),
	`previewUrl` text,
	`activeSkillId` varchar(64),
	`reviewState` varchar(32),
	CONSTRAINT `Thread_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `User` (
	`id` varchar(36) NOT NULL,
	`email` varchar(128) NOT NULL,
	`name` text,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `User_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `Message` ADD CONSTRAINT `Message_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Thread` ADD CONSTRAINT `Thread_userId_User_id_fk` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE no action ON UPDATE no action;