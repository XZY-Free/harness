-- S12-W05：Workload Token 撤销表。
--
-- 事实源：14-production-operations-security-and-retention.md §5（运行时隔离与 Secret）、
--         11-api-and-event-boundaries.md §9.1（Token 绑定 tenant/invocation/runtime_revision/audience/TTL）。
--
-- 变更：
-- 1. 新建 V11WorkloadTokenRevocation 表：记录已撤销的 Workload Token jti。
-- 2. 撤销后 route handler 在 resolveRuntimePrincipal/resolveGatewayPrincipal 中查询此表，
--    命中则拒绝（401 AUTHENTICATION_REQUIRED）。
-- 3. jti 在 Token 颁发时生成（randomUUID），decodeWorkloadToken 校验 jti 必填。
-- 4. 表按 (tenantId, jti) 唯一索引，避免重复撤销；按 (tenantId, revokedAt) 索引便于清理。

CREATE TABLE `V11WorkloadTokenRevocation` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `jti` varchar(64) NOT NULL,
  `tokenType` varchar(16) NOT NULL,
  `revokedBy` varchar(128) NOT NULL,
  `reason` text NOT NULL,
  `expiresAt` datetime(3) NOT NULL,
  `revokedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `V11WorkloadTokenRevocation_tenant_jti_uq` (`tenantId`, `jti`),
  KEY `V11WorkloadTokenRevocation_tenant_revoked_idx` (`tenantId`, `revokedAt`),
  KEY `V11WorkloadTokenRevocation_expires_idx` (`expiresAt`),
  CONSTRAINT `V11WorkloadTokenRevocation_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
