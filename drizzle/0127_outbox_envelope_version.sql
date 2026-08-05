-- §3.1: 冻结事件Envelope — 添加 schemaVersion + aggregateVersion
-- 参见：SnowHarness专题01全局统一与最终收敛方案 §3.1

-- 1. 添加 schemaVersion 列（默认 "1.0"）
ALTER TABLE `ControlPlaneOutboxEvent` ADD COLUMN `schemaVersion` varchar(8) NOT NULL DEFAULT '1.0' AFTER `tenantId`;

--> statement-breakpoint

-- 2. 添加 aggregateVersion 列（默认 0，新事件由 Producer 传入真实版本号）
ALTER TABLE `ControlPlaneOutboxEvent` ADD COLUMN `aggregateVersion` int NOT NULL DEFAULT 0 AFTER `aggregateId`;
