-- V11 policy_set / policy_revision / policy 表（S13-C03 policy 域迁移目标）。
--
-- 事实源：lib/v11/schema/permission.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §4.4（policy_set / policy_revision）、
--         ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §2.5。
--
-- 关键约束：
-- - UNIQUE(tenantId, policySetKey)：租户内稳定 key 唯一。
-- - UNIQUE(policySetId, revisionNo)：PolicySet 内修订号单调递增。
-- - published Revision 业务内容不可修改；只能新建版本。
-- - V11Policy.decision 与 V11PermissionDecision.decision 对齐（allow/pause/block）。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
CREATE TABLE `V11PolicySet` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `policySetKey` varchar(128) NOT NULL,
  `ownerUserId` varchar(36) NULL,
  `currentRevisionId` varchar(36) NULL,
  `lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11PolicySet_tenant_policySetKey_uq`(`tenantId`,`policySetKey`),
  KEY `V11PolicySet_tenant_lifecycle_updated_idx`(`tenantId`,`lifecycleState`,`updatedAt`),
  CONSTRAINT `V11PolicySet_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11PolicyRevision` (
  `id` varchar(36) NOT NULL,
  `policySetId` varchar(36) NOT NULL,
  `revisionNo` bigint NOT NULL,
  `revisionJson` json NOT NULL,
  `rulesHash` varchar(128) NOT NULL,
  `revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
  `createdBy` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `publishedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11PolicyRevision_set_revisionNo_uq`(`policySetId`,`revisionNo`),
  KEY `V11PolicyRevision_set_state_idx`(`policySetId`,`revisionState`),
  CONSTRAINT `V11PolicyRevision_policySetId_fk` FOREIGN KEY (`policySetId`) REFERENCES `V11PolicySet`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11Policy` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `policySetId` varchar(36) NOT NULL,
  `policyRevisionId` varchar(36) NULL,
  `toolPattern` varchar(128) NOT NULL,
  `argMatcherJson` json NULL,
  `decision` enum('allow','pause','block') NOT NULL,
  `scopeJson` json NOT NULL,
  `reason` varchar(256) NULL,
  `priority` int NOT NULL DEFAULT 0,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  KEY `V11Policy_tenant_set_idx`(`tenantId`,`policySetId`),
  KEY `V11Policy_tenant_decision_idx`(`tenantId`,`decision`),
  CONSTRAINT `V11Policy_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11Policy_policySetId_fk` FOREIGN KEY (`policySetId`) REFERENCES `V11PolicySet`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
