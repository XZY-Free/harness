CREATE TABLE `MemoryExtractionRun` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`threadId` varchar(36),
	`trigger` enum('pre_compaction','explicit','session_end') NOT NULL,
	`sourceRangesHash` varchar(128) NOT NULL,
	`extractedCount` int NOT NULL DEFAULT 0,
	`decisionsJson` json,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `MemoryExtractionRun_id` PRIMARY KEY(`id`),
	CONSTRAINT `MemoryExtractionRun_invocation_range_uq` UNIQUE(`invocationId`,`trigger`,`sourceRangesHash`)
);
--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD `memoryCategory` enum('user','feedback','project','reference','decision') DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD `invalidAt` datetime(3);--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD `expiredAt` datetime(3);--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD `supersedesEntryId` varchar(36);--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD `supersededByEntryId` varchar(36);--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD `indexedRevisionRef` varchar(512);--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD `retrievalCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD `lastRetrievedAt` datetime(3);--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD `extractionRunId` varchar(36);--> statement-breakpoint
ALTER TABLE `MemoryExtractionRun` ADD CONSTRAINT `MemoryExtractionRun_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `MemoryExtractionRun_tenant_created_idx` ON `MemoryExtractionRun` (`tenantId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_tenant_state_invalid_idx` ON `MemoryEntry` (`tenantId`,`memoryState`,`invalidAt`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_supersededBy_idx` ON `MemoryEntry` (`supersededByEntryId`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_tenant_category_idx` ON `MemoryEntry` (`tenantId`,`memoryCategory`,`memoryState`);