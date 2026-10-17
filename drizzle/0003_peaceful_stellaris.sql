DROP INDEX `ToolSyncBinding_tenant_localTool_idx` ON `ToolSyncBinding`;--> statement-breakpoint
ALTER TABLE `ToolSyncBinding` MODIFY COLUMN `localToolId` varchar(36);--> statement-breakpoint
ALTER TABLE `ToolSyncBinding` MODIFY COLUMN `localProviderId` varchar(36) NOT NULL;--> statement-breakpoint
CREATE INDEX `ToolSyncBinding_tenant_localProvider_idx` ON `ToolSyncBinding` (`tenantId`,`localProviderId`);