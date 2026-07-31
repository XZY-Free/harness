-- S1（10-P2-5）：MCP server 版本/能力协商记录落 DB
-- 连接成功后 best-effort 回写 lastServerVersion/lastCapabilities/lastConnectedAt，审计兼容性
ALTER TABLE `McpServerConfig` ADD `lastServerVersion` varchar(128);--> statement-breakpoint
ALTER TABLE `McpServerConfig` ADD `lastCapabilities` json;--> statement-breakpoint
ALTER TABLE `McpServerConfig` ADD `lastConnectedAt` datetime;
