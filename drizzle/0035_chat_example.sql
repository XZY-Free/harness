CREATE TABLE `ChatExample` (
	`id` varchar(36) NOT NULL,
	`content` text NOT NULL,
	`sortOrder` int NOT NULL DEFAULT 0,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `ChatExample_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ChatExample_enabled_sortOrder_idx` ON `ChatExample` (`enabled`,`sortOrder`);