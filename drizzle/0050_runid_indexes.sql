-- P2-4: contextSnapshot/toolRun/threadEvent 的 runId 列加索引(getRunDetail 按 runId 查全表扫)
CREATE INDEX `ContextSnapshot_runId_idx` ON `ContextSnapshot` (`runId`);--> statement-breakpoint
CREATE INDEX `ToolRun_runId_idx` ON `ToolRun` (`runId`);--> statement-breakpoint
CREATE INDEX `ThreadEvent_runId_idx` ON `ThreadEvent` (`runId`);
