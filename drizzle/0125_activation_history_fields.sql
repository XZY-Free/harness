-- §2.5: 保留 Activation 历史 — 添加 previousRouteActivationId 字段
-- 参见：SnowHarness专题01全局统一与最终收敛方案 §2.5

ALTER TABLE `RouteActivation` ADD COLUMN `previousRouteActivationId` varchar(36) DEFAULT NULL AFTER `previousRouteRevisionId`;
