ALTER TABLE `ThreadEvent` ADD CONSTRAINT `ThreadEvent_threadId_sequence_uq` UNIQUE(`threadId`,`sequence`);--> statement-breakpoint
CREATE INDEX `ThreadEvent_threadId_createdAt_idx` ON `ThreadEvent` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ToolRun_threadId_startedAt_idx` ON `ToolRun` (`threadId`,`startedAt`);--> statement-breakpoint
CREATE INDEX `ToolRun_threadId_toolName_idx` ON `ToolRun` (`threadId`,`toolName`);--> statement-breakpoint
CREATE INDEX `ToolRun_status_startedAt_idx` ON `ToolRun` (`status`,`startedAt`);