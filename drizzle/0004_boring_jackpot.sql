-- Phase 4-3：User.externalId（SSO 身份映射键）+ Thread (userId, createdAt) 索引
-- 手动调整为数据安全顺序：先加可空列 → 用现有 id 回填 → 收紧 NOT NULL → 建唯一索引
-- （drizzle 默认生成的「先 UNIQUE 后 NOT NULL ADD」会让既有行失败，故改写）
ALTER TABLE `User` ADD `externalId` varchar(128);--> statement-breakpoint
UPDATE `User` SET `externalId` = `id` WHERE `externalId` IS NULL;--> statement-breakpoint
ALTER TABLE `User` MODIFY COLUMN `externalId` varchar(128) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `User_externalId_uq` ON `User` (`externalId`);--> statement-breakpoint
CREATE INDEX `Thread_userId_createdAt_idx` ON `Thread` (`userId`,`createdAt`);
