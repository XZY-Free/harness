-- X2 修复：UserBrowserProfile.expiresAt 与 lastUsedAt 时间精度不一致。
-- lastUsedAt 已是 datetime(3) 毫秒精度，expiresAt 仍是 datetime 秒精度。
-- 毫秒被截断导致边界比较抖动。统一升级到 datetime(3)。
-- MySQL 8 MODIFY datetime 改 fsp 是 instant 算法，不锁表，现有秒值补 .000。
ALTER TABLE `UserBrowserProfile` MODIFY `expiresAt` datetime(3) NOT NULL;
