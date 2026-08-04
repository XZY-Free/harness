-- §2.2: Route 稳定身份显式化 — 增加 routeKey 字段 + UNIQUE(routeSetId, routeKey)
-- 参见：SnowHarness专题01全局统一与最终收敛方案 §2.2

-- 1. RouteRevision 增加 routeKey 列
ALTER TABLE `RouteRevision` ADD COLUMN `routeKey` varchar(128) NOT NULL DEFAULT '' AFTER `routeSetId`;

-- 2. V11DeploymentRoute 增加 routeKey 列
ALTER TABLE `V11DeploymentRoute` ADD COLUMN `routeKey` varchar(128) NOT NULL DEFAULT '' AFTER `routeSetId`;

-- 3. 回填 routeKey：使用 agentRevisionId + runtimeRevisionId 组合作为过渡期 routeKey
UPDATE `V11DeploymentRoute` SET `routeKey` = CONCAT(`agentRevisionId`, ':', `runtimeRevisionId`) WHERE `routeKey` = '';
UPDATE `RouteRevision` SET `routeKey` = CONCAT(`agentRevisionId`, ':', `runtimeRevisionId`) WHERE `routeKey` = '';

-- 4. 删除旧的唯一约束（agentRevisionId + runtimeRevisionId）
DROP INDEX `V11DeploymentRoute_set_agent_runtime_uq` ON `V11DeploymentRoute`;

-- 5. 创建新的唯一约束（routeSetId + routeKey）
CREATE UNIQUE INDEX `V11DeploymentRoute_set_routeKey_uq` ON `V11DeploymentRoute` (`routeSetId`, `routeKey`);
