CREATE TABLE `MemoryEmbedding` (
	`id` varchar(36) NOT NULL,
	`memoryId` varchar(36) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`model` varchar(128) NOT NULL,
	`vector` json NOT NULL,
	`dim` int NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`errorMessage` varchar(512),
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `MemoryEmbedding_id` PRIMARY KEY(`id`),
	CONSTRAINT `MemoryEmbedding_memoryId_provider_uniq` UNIQUE(`memoryId`,`provider`)
);
--> statement-breakpoint
CREATE TABLE `MemoryEntry` (
	`id` varchar(36) NOT NULL,
	`scope` varchar(32) NOT NULL,
	`scopeRef` varchar(36),
	`kind` varchar(32) NOT NULL,
	`text` text NOT NULL,
	`textHash` varchar(64) NOT NULL,
	`provenance` json NOT NULL,
	`confidence` varchar(16) NOT NULL DEFAULT 'medium',
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`expiresAt` datetime,
	`createdByToolRunId` varchar(36),
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `MemoryEntry_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `MemoryEmbedding` ADD CONSTRAINT `MemoryEmbedding_memoryId_MemoryEntry_id_fk` FOREIGN KEY (`memoryId`) REFERENCES `MemoryEntry`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `MemoryEmbedding_memoryId_idx` ON `MemoryEmbedding` (`memoryId`);--> statement-breakpoint
CREATE INDEX `MemoryEmbedding_provider_idx` ON `MemoryEmbedding` (`provider`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_scope_scopeRef_status_idx` ON `MemoryEntry` (`scope`,`scopeRef`,`status`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_kind_idx` ON `MemoryEntry` (`kind`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_textHash_idx` ON `MemoryEntry` (`textHash`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_scope_scopeRef_expiresAt_idx` ON `MemoryEntry` (`scope`,`scopeRef`,`expiresAt`);