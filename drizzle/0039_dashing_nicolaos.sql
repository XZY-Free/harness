ALTER TABLE `ToolApprovalRequest` ADD `projectId` varchar(36);--> statement-breakpoint
CREATE INDEX `ToolApprovalRequest_scope_projectId_idx` ON `ToolApprovalRequest` (`approvedScope`,`projectId`);