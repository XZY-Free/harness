-- 0119: CutoverPlan 和 CutoverItem 表
-- 第二批：历史控制面资格扫描与受控切换

CREATE TABLE IF NOT EXISTS `CutoverPlan` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `routeSetId` varchar(36) NOT NULL,
  `sourceRouteSetVersionNo` int NOT NULL,
  `targetRouteSetVersionNo` int DEFAULT NULL,
  `state` enum('draft','inventory_complete','requalifying','ready_to_activate','activated','failed','cancelled') NOT NULL DEFAULT 'draft',
  `createdBy` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  `startedAt` datetime(3) DEFAULT NULL,
  `completedAt` datetime(3) DEFAULT NULL,
  `failedAt` datetime(3) DEFAULT NULL,
  `failureReason` varchar(512) DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `CutoverPlan_tenantId_idx` (`tenantId`),
  INDEX `CutoverPlan_routeSetId_idx` (`routeSetId`),
  INDEX `CutoverPlan_state_idx` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `CutoverItem` (
  `id` varchar(36) NOT NULL,
  `planId` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `subjectType` enum('agent_revision','runtime_revision') NOT NULL,
  `sourceSubjectId` varchar(36) NOT NULL,
  `replacementSubjectId` varchar(36) DEFAULT NULL,
  `state` enum('pending','artifact_pending','attestation_pending','conformance_pending','publication_pending','ready','failed','manual_review') NOT NULL DEFAULT 'pending',
  `qualificationCategory` enum('trusted','legacy_projection_only','missing_artifact','missing_attestation','missing_conformance','withdrawn','invalid_digest','manual_review_needed') NOT NULL,
  `attemptCount` int NOT NULL DEFAULT 0,
  `nextAttemptAt` datetime(3) DEFAULT NULL,
  `leaseOwner` varchar(128) DEFAULT NULL,
  `leaseExpiresAt` datetime(3) DEFAULT NULL,
  `lastError` varchar(512) DEFAULT NULL,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `CutoverItem_planId_subjectType_sourceSubjectId_uq` (`planId`, `subjectType`, `sourceSubjectId`),
  INDEX `CutoverItem_planId_idx` (`planId`),
  INDEX `CutoverItem_tenantId_idx` (`tenantId`),
  INDEX `CutoverItem_state_idx` (`state`),
  INDEX `CutoverItem_claimable_idx` (`state`, `nextAttemptAt`, `leaseExpiresAt`),
  CONSTRAINT `CutoverItem_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `CutoverPlan` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
