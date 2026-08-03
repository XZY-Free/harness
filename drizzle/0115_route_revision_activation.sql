ALTER TABLE `V11DeploymentRoute`
  ADD COLUMN `activeRouteRevisionId` varchar(36) NULL AFTER `effectiveUntil`,
  ADD KEY `V11DeploymentRoute_activeRouteRevision_idx` (`activeRouteRevisionId`);
--> statement-breakpoint
CREATE TABLE `RouteRevision` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `routeId` varchar(36) NOT NULL,
  `routeSetId` varchar(36) NOT NULL,
  `revisionNo` bigint unsigned NOT NULL,
  `agentRevisionId` varchar(36) NOT NULL,
  `runtimeRevisionId` varchar(36) NOT NULL,
  `policyRevisionId` varchar(36) NULL,
  `modelPolicyRevisionId` varchar(36) NULL,
  `toolsetRevisionId` varchar(36) NULL,
  `trafficAllocationJson` json NOT NULL,
  `trafficWeight` int NOT NULL,
  `priorityNo` int NOT NULL,
  `effectiveFrom` datetime(3) NULL,
  `effectiveUntil` datetime(3) NULL,
  `eligibilityConditionsJson` json NOT NULL,
  `contentDigest` varchar(71) NOT NULL,
  `createdByType` enum('user','service','workload','system') NOT NULL,
  `createdBy` varchar(128) NOT NULL,
  `validatedAt` datetime(3) NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `RouteRevision_route_revisionNo_uq` (`routeId`,`revisionNo`),
  UNIQUE KEY `RouteRevision_route_content_uq` (`routeId`,`contentDigest`),
  KEY `RouteRevision_routeSet_idx` (`routeSetId`,`createdAt`),
  CONSTRAINT `RouteRevision_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `RouteRevision_routeId_fk` FOREIGN KEY (`routeId`) REFERENCES `V11DeploymentRoute` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `RouteRevision_routeSetId_fk` FOREIGN KEY (`routeSetId`) REFERENCES `V11DeploymentRouteSet` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `RouteRevision_agentRevisionId_fk` FOREIGN KEY (`agentRevisionId`) REFERENCES `V11AgentRevision` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `RouteRevision_runtimeRevisionId_fk` FOREIGN KEY (`runtimeRevisionId`) REFERENCES `V11RuntimeRevision` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE `RouteActivation` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `routeId` varchar(36) NOT NULL,
  `routeRevisionId` varchar(36) NOT NULL,
  `activationSequence` bigint unsigned NOT NULL,
  `activationState` enum('active','disabled') NOT NULL,
  `previousRouteRevisionId` varchar(36) NULL,
  `routeSetVersionNo` bigint unsigned NOT NULL,
  `activatedByType` enum('user','service','workload','system') NOT NULL,
  `activatedBy` varchar(128) NOT NULL,
  `reason` text NOT NULL,
  `requestId` varchar(64) NOT NULL,
  `idempotencyKey` varchar(256) NOT NULL,
  `activatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `RouteActivation_route_sequence_uq` (`routeId`,`activationSequence`),
  UNIQUE KEY `RouteActivation_route_idempotency_uq` (`routeId`,`idempotencyKey`),
  KEY `RouteActivation_revision_activated_idx` (`routeRevisionId`,`activatedAt`),
  CONSTRAINT `RouteActivation_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `RouteActivation_routeId_fk` FOREIGN KEY (`routeId`) REFERENCES `V11DeploymentRoute` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `RouteActivation_routeRevisionId_fk` FOREIGN KEY (`routeRevisionId`) REFERENCES `RouteRevision` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `RouteActivation_previousRouteRevisionId_fk` FOREIGN KEY (`previousRouteRevisionId`) REFERENCES `RouteRevision` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
INSERT INTO `RouteRevision` (
  `id`, `tenantId`, `routeId`, `routeSetId`, `revisionNo`, `agentRevisionId`,
  `runtimeRevisionId`, `trafficAllocationJson`, `trafficWeight`, `priorityNo`,
  `effectiveFrom`, `effectiveUntil`, `eligibilityConditionsJson`, `contentDigest`,
  `createdByType`, `createdBy`, `validatedAt`, `createdAt`
)
SELECT
  UUID(), route_set.`tenantId`, route_row.`id`, route_row.`routeSetId`, 1,
  route_row.`agentRevisionId`, route_row.`runtimeRevisionId`,
  JSON_OBJECT('weightBasisPoints', route_row.`trafficWeight`), route_row.`trafficWeight`,
  route_row.`priorityNo`, route_row.`effectiveFrom`, route_row.`effectiveUntil`, JSON_OBJECT(),
  CONCAT('sha256:', SHA2(CONCAT_WS('|', route_row.`id`, route_row.`agentRevisionId`,
    route_row.`runtimeRevisionId`, route_row.`trafficWeight`, route_row.`priorityNo`,
    COALESCE(route_row.`effectiveFrom`, ''), COALESCE(route_row.`effectiveUntil`, '')), 256)),
  'system', 'route-revision-migration', route_row.`updatedAt`, route_row.`createdAt`
FROM `V11DeploymentRoute` route_row
INNER JOIN `V11DeploymentRouteSet` route_set ON route_set.`id` = route_row.`routeSetId`;
--> statement-breakpoint
INSERT INTO `RouteActivation` (
  `id`, `tenantId`, `routeId`, `routeRevisionId`, `activationSequence`, `activationState`,
  `previousRouteRevisionId`, `routeSetVersionNo`, `activatedByType`, `activatedBy`,
  `reason`, `requestId`, `idempotencyKey`, `activatedAt`
)
SELECT
  UUID(), revision.`tenantId`, revision.`routeId`, revision.`id`, 1,
  CASE WHEN route_row.`routeState` = 'disabled' THEN 'disabled' ELSE 'active' END,
  NULL, route_set.`versionNo`, 'system', 'route-revision-migration',
  '迁移既有 DeploymentRoute 当前投影', CONCAT('migration:', revision.`routeId`),
  CONCAT('migration:', revision.`id`), route_row.`updatedAt`
FROM `RouteRevision` revision
INNER JOIN `V11DeploymentRoute` route_row ON route_row.`id` = revision.`routeId`
INNER JOIN `V11DeploymentRouteSet` route_set ON route_set.`id` = revision.`routeSetId`
WHERE revision.`revisionNo` = 1;
--> statement-breakpoint
UPDATE `V11DeploymentRoute` route_row
INNER JOIN `RouteRevision` revision ON revision.`routeId` = route_row.`id` AND revision.`revisionNo` = 1
SET route_row.`activeRouteRevisionId` = revision.`id`;
--> statement-breakpoint
ALTER TABLE `V11DeploymentRoute`
  ADD CONSTRAINT `V11DeploymentRoute_activeRouteRevisionId_fk`
  FOREIGN KEY (`activeRouteRevisionId`) REFERENCES `RouteRevision` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
