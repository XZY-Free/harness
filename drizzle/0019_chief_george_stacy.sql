CREATE TABLE `CustomTool` (
	`id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`description` varchar(1024) NOT NULL,
	`inputSchema` json NOT NULL,
	`executorType` varchar(16) NOT NULL,
	`executorConfig` json NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `CustomTool_id` PRIMARY KEY(`id`),
	CONSTRAINT `CustomTool_name_uq` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `McpServerConfig` (
	`id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`transport` varchar(16) NOT NULL,
	`command` varchar(512),
	`args` json,
	`url` varchar(512),
	`env` json,
	`allowedTools` json,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `McpServerConfig_id` PRIMARY KEY(`id`),
	CONSTRAINT `McpServerConfig_name_uq` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE INDEX `CustomTool_enabled_idx` ON `CustomTool` (`enabled`);--> statement-breakpoint
CREATE INDEX `McpServerConfig_enabled_idx` ON `McpServerConfig` (`enabled`);