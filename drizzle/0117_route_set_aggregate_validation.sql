-- Migration 0117: RouteSet 聚合校验支持
--
-- 新增 nullable 列，部署兼容代码处理 NULL。
-- 幂等 Backfill 命令将使用正式 RouteSelector 算法回填。
-- Migration 0118 在回填后验证零 NULL 并增加 NOT NULL + 最终索引。

-- RouteRevision 新增 routeGroupId 和 selectorDigest
ALTER TABLE `RouteRevision`
  ADD COLUMN `routeGroupId` varchar(128) NULL AFTER `trafficAllocationJson`,
  ADD COLUMN `selectorDigest` varchar(71) NULL AFTER `routeGroupId`;
--> statement-breakpoint
-- RouteActivation 新增 routeSetId（派生冗余列，= 对应 RouteRevision.routeSetId）
ALTER TABLE `RouteActivation`
  ADD COLUMN `routeSetId` varchar(36) NULL AFTER `routeRevisionId`;
--> statement-breakpoint
-- 临时索引：加速 Backfill 查询
ALTER TABLE `RouteRevision`
  ADD KEY `RouteRevision_routeSetId_routeGroupId_tmp_idx` (`routeSetId`, `routeGroupId`),
  ADD KEY `RouteRevision_routeSetId_selectorDigest_tmp_idx` (`routeSetId`, `selectorDigest`);
--> statement-breakpoint
ALTER TABLE `RouteActivation`
  ADD KEY `RouteActivation_routeSetId_tmp_idx` (`routeSetId`);
