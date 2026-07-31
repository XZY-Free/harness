-- P2-6: message 复合索引补 id 列,覆盖游标分页 (createdAt, id) tie-breaker。
-- 旧索引被 message.threadId FK 用作外键索引,需先建新索引(覆盖 threadId)再删旧,否则 ER_DROP_INDEX_FK。
CREATE INDEX `Message_threadId_createdAt_id_idx` ON `Message` (`threadId`,`createdAt`,`id`);--> statement-breakpoint
DROP INDEX `Message_threadId_createdAt_idx` ON `Message`;
