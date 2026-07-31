-- P1-10: SSE since 游标依赖 datetime 精度,fsp=0 秒精度下 gt(createdAt,since) 会丢同秒事件。
-- Thread.updatedAt 与 ThreadEvent.createdAt 升级到 datetime(3) 毫秒精度。
-- MySQL 8 MODIFY datetime 改 fsp 是 instant 算法,不锁表,现有秒值补 .000。
ALTER TABLE `Thread` MODIFY `updatedAt` datetime(3) NOT NULL;
--> statement-breakpoint
ALTER TABLE `ThreadEvent` MODIFY `createdAt` datetime(3) NOT NULL;
