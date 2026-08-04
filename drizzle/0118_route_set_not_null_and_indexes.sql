-- Migration 0118: RouteSet 聚合校验 — NOT NULL 约束和最终索引
--
-- 前提：backfill-route-group-fields 已完成，verifyBackfillComplete() 返回 ready=true。
--
-- 此 Migration 不得在回填未完成时运行。

-- ─── NOT NULL 约束 ────────────────────────────────────────
ALTER TABLE `RouteRevision`
  MODIFY `routeGroupId` varchar(128) NOT NULL DEFAULT 'primary';
--> statement-breakpoint
ALTER TABLE `RouteRevision`
  MODIFY `selectorDigest` varchar(71) NOT NULL;
--> statement-breakpoint
ALTER TABLE `RouteActivation`
  MODIFY `routeSetId` varchar(36) NOT NULL;
--> statement-breakpoint

-- ─── 最终索引 ─────────────────────────────────────────────
ALTER TABLE `RouteRevision`
  ADD KEY `RouteRevision_routeSetId_routeGroupId_priorityNo_idx` (`routeSetId`, `routeGroupId`, `priorityNo`);
--> statement-breakpoint
ALTER TABLE `RouteRevision`
  ADD KEY `RouteRevision_routeSetId_selectorDigest_priorityNo_idx` (`routeSetId`, `selectorDigest`, `priorityNo`);
--> statement-breakpoint
ALTER TABLE `RouteActivation`
  ADD KEY `RouteActivation_routeSetId_routeSetVersionNo_idx` (`routeSetId`, `routeSetVersionNo`);
--> statement-breakpoint

-- ─── 清理临时索引 ─────────────────────────────────────────
ALTER TABLE `RouteRevision`
  DROP KEY `RouteRevision_routeSetId_routeGroupId_tmp_idx`;
--> statement-breakpoint
ALTER TABLE `RouteRevision`
  DROP KEY `RouteRevision_routeSetId_selectorDigest_tmp_idx`;
--> statement-breakpoint
ALTER TABLE `RouteActivation`
  DROP KEY `RouteActivation_routeSetId_tmp_idx`;
