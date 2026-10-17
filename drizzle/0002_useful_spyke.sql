CREATE TABLE `ToolSyncBinding` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`assetType` varchar(16) NOT NULL,
	`remoteAssetId` varchar(256) NOT NULL,
	`remoteName` varchar(128) NOT NULL,
	`remoteDisplayName` varchar(256),
	`remoteVersion` varchar(128) NOT NULL,
	`remoteVersionId` varchar(256),
	`remoteContentHash` varchar(256),
	`localToolId` varchar(36) NOT NULL,
	`localProviderId` varchar(36),
	`localName` varchar(128) NOT NULL,
	`syncState` varchar(32) NOT NULL DEFAULT 'active',
	`lastSyncedAt` datetime(3),
	`lastCheckedAt` datetime(3),
	`lastError` text,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `ToolSyncBinding_id` PRIMARY KEY(`id`),
	CONSTRAINT `ToolSyncBinding_tenant_remoteAssetId_uq` UNIQUE(`tenantId`,`remoteAssetId`)
);
--> statement-breakpoint
ALTER TABLE `ToolSyncBinding` ADD CONSTRAINT `ToolSyncBinding_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ToolSyncBinding` ADD CONSTRAINT `ToolSyncBinding_localToolId_Tool_id_fk` FOREIGN KEY (`localToolId`) REFERENCES `Tool`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ToolSyncBinding` ADD CONSTRAINT `ToolSyncBinding_localProviderId_ToolProvider_id_fk` FOREIGN KEY (`localProviderId`) REFERENCES `ToolProvider`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ToolSyncBinding_tenant_localTool_idx` ON `ToolSyncBinding` (`tenantId`,`localToolId`);--> statement-breakpoint
CREATE INDEX `ToolSyncBinding_tenant_syncState_idx` ON `ToolSyncBinding` (`tenantId`,`syncState`);