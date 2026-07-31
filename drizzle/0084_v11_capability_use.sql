-- V11 Stage 6 S06-C04: capability_use（能力使用账本）
--
-- 事实源：lib/v11/schema/capability-use.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §6.5（capability_use）、
--         ../v11-agentkit-platform/12-capability-and-collaboration-api.md §3（Runtime Capability API）。
--
-- 关键约束：
-- - UNIQUE(invocationId, capabilityUseKey)：同一 Invocation 内同一能力修订不重复记录。
-- - INDEX(tenantId, invocationId)：按 Invocation 查询能力使用历史。
-- - INDEX(tenantId, capabilityType, capabilityId)：按能力维度统计使用情况。
-- - capabilityUseKey = sha256(type|id|revision-or-empty|content-hash-or-empty|schema-hash-or-empty)。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
-- - invocationId 不加 DB 级 FK，避免跨阶段耦合（由 Invocation 表后续阶段保证存在性）。
CREATE TABLE `V11CapabilityUse` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `capabilityType` varchar(32) NOT NULL,
  `capabilityId` varchar(36) NOT NULL,
  `revisionId` varchar(36) NULL,
  `contentHash` varchar(128) NULL,
  `schemaHash` varchar(128) NULL,
  `sourceType` varchar(32) NOT NULL DEFAULT 'dynamic_discovery',
  `sourceRef` varchar(256) NULL,
  `selectionReasonCode` varchar(64) NULL,
  `capabilityUseKey` varchar(128) NOT NULL,
  `firstUsedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11CapabilityUse_invocation_capabilityUseKey_uq`(`invocationId`,`capabilityUseKey`),
  KEY `V11CapabilityUse_tenant_invocation_idx`(`tenantId`,`invocationId`),
  KEY `V11CapabilityUse_tenant_type_capability_idx`(`tenantId`,`capabilityType`,`capabilityId`),
  CONSTRAINT `V11CapabilityUse_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
