-- 0120: HostedProvisioningRequest 表
-- 第二批：Hosted 异步供应请求（从用户 Turn 热路径迁入后台工作流）

CREATE TABLE IF NOT EXISTS `HostedProvisioningRequest` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `agentId` varchar(36) NOT NULL,
  `agentRevisionId` varchar(36) NOT NULL,
  `routeScopeKey` varchar(64) NOT NULL,
  `desiredRuntimeKey` varchar(64) NOT NULL,
  `state` enum('pending','running','waiting_external_evidence','waiting_conformance','ready','retryable_failed','permanent_failed','cancelled') NOT NULL DEFAULT 'pending',
  `currentStep` varchar(64) DEFAULT NULL,
  `attemptCount` int NOT NULL DEFAULT 0,
  `nextAttemptAt` datetime(3) DEFAULT NULL,
  `leaseOwner` varchar(128) DEFAULT NULL,
  `leaseExpiresAt` datetime(3) DEFAULT NULL,
  `lastError` varchar(512) DEFAULT NULL,
  `lastAttemptAt` datetime(3) DEFAULT NULL,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `HostedProvisioningRequest_active_uq` (`tenantId`, `agentRevisionId`, `routeScopeKey`, `desiredRuntimeKey`),
  INDEX `HostedProvisioningRequest_tenantId_idx` (`tenantId`),
  INDEX `HostedProvisioningRequest_agentId_idx` (`agentId`),
  INDEX `HostedProvisioningRequest_state_idx` (`state`),
  INDEX `HostedProvisioningRequest_claimable_idx` (`state`, `nextAttemptAt`, `leaseExpiresAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
