ALTER TABLE `SubagentRun` ADD `contextHints` json;--> statement-breakpoint
-- B-8: 加 updatedAt 列。先给 DEFAULT CURRENT_TIMESTAMP 避免已有数据 NOT NULL 报错，
-- 再回填为 createdAt（语义：历史 thread 的最后活动时间 = 创建时间）。
ALTER TABLE `Thread` ADD `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
UPDATE `Thread` SET `updatedAt` = `createdAt` WHERE `updatedAt` IS NULL;--> statement-breakpoint
CREATE INDEX `Thread_userId_updatedAt_idx` ON `Thread` (`userId`,`updatedAt`);