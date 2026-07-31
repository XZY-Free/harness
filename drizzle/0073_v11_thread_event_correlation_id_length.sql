-- S04-C03：扩大 V11ThreadEvent.correlationId / causationId 字段长度
--
-- 事实源：lib/v11/schema/conversation.ts
-- 原因：X-Request-Id 平台规范为 `req_${uuid}`（40 字符），超过原 varchar(36) 限制；
--       W3C traceparent（55 字符）等其他关联标识也需更大容量。
-- 影响：仅扩大长度，不改变 nullable / 索引语义；历史数据无影响。
ALTER TABLE `V11ThreadEvent` MODIFY COLUMN `correlationId` varchar(128) NULL;--> statement-breakpoint
ALTER TABLE `V11ThreadEvent` MODIFY COLUMN `causationId` varchar(128) NULL;
