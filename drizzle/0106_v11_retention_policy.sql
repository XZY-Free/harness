-- S12-W06：数据保留策略与 Legal Hold 表。
--
-- 事实源：14-production-operations-security-and-retention.md §6
--         （为 Thread/Event/Trace/Audit/Artifact/Memory/Knowledge/Job/安全记录定义独立保留策略；
--           Legal Hold 明确对象范围、原因、创建人、批准人、有效期和解除审计）。
--
-- 变更：
-- 1. 新建 V11RetentionPolicy 表：按 (tenantId, objectType) 唯一的保留策略。
--    retentionDays 决定过期清理；legalHoldDays 为 Legal Hold 解除后的额外保留窗口。
--    dataClass 与 statutoryRequirements 用于解析适用策略（不把一个天数硬编码到所有存储）。
-- 2. 新建 V11LegalHold 表：按 (tenantId, targetType, targetId) 唯一的 Legal Hold 记录。
--    holdState=active 时阻止该对象的删除；released 后恢复原保留策略计算。
--    reason/createdBy/approvedBy/validUntil 全部记录，解除时写审计（legal_hold.manage）。
-- 3. Legal Hold 不扩大到无关对象：仅匹配的 target 被阻止删除。

CREATE TABLE `V11RetentionPolicy` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `objectType` enum('thread','event','trace','audit','artifact','memory','knowledge','job','security_log') NOT NULL,
  `retentionDays` varchar(16) NOT NULL,
  `legalHoldDays` varchar(16),
  `dataClass` varchar(64) NOT NULL,
  `statutoryRequirements` text NOT NULL,
  `description` text NOT NULL,
  `createdBy` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedBy` varchar(128) NOT NULL,
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `V11RetentionPolicy_tenant_object_uq` (`tenantId`, `objectType`),
  KEY `V11RetentionPolicy_tenant_data_class_idx` (`tenantId`, `dataClass`),
  CONSTRAINT `V11RetentionPolicy_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE `V11LegalHold` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `targetType` enum('tenant','thread','invocation','job','artifact','agent_revision') NOT NULL,
  `targetId` varchar(128) NOT NULL,
  `holdState` enum('active','released') NOT NULL DEFAULT 'active',
  `reason` text NOT NULL,
  `createdBy` varchar(128) NOT NULL,
  `approvedBy` varchar(128) NOT NULL,
  `validUntil` datetime(3) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `releasedAt` datetime(3),
  `releasedBy` varchar(128),
  `releaseReason` text,
  PRIMARY KEY (`id`),
  UNIQUE KEY `V11LegalHold_tenant_target_uq` (`tenantId`, `targetType`, `targetId`),
  KEY `V11LegalHold_tenant_state_idx` (`tenantId`, `holdState`),
  KEY `V11LegalHold_valid_until_idx` (`validUntil`),
  CONSTRAINT `V11LegalHold_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
