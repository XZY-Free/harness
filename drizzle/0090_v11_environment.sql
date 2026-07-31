-- V11 Stage 8 S08-C02: environment_definition / environment_lease /
-- environment_change_request
--
-- 事实源：lib/v11/schema/environment.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §6.13（execution_ownership 与
--         environment_change_request）、§7.2（environment_definition 与 environment_lease）、
--         ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W02。
--
-- 关键约束：
-- - UNIQUE(tenantId, environmentKey)：租户内 Definition 稳定 key 唯一。
-- - UNIQUE(invocationId, attemptId)：同一 Invocation 同一 Attempt 只能有一个 Lease。
-- - environmentDefinitionId 外键 → V11EnvironmentDefinition(id) ON DELETE RESTRICT
--   （防止 Definition 被删时 Lease 悬空）。
-- - invocationId 外键 → V11Invocation(id) ON DELETE CASCADE。
-- - Desktop Lease 必含 deviceId（应用层校验）；Cloud/Remote/Sandbox 可空。
-- - EnvironmentChangeRequest 的 from/requested environmentDefinitionId 外键 ON DELETE RESTRICT。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
CREATE TABLE `V11EnvironmentDefinition` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `environmentKey` varchar(128) NOT NULL,
  `displayName` varchar(256) NOT NULL,
  `description` text NULL,
  `environmentType` enum('desktop','cloud','remote','sandbox') NOT NULL,
  `filesystemPolicyJson` json NOT NULL,
  `networkPolicyJson` json NOT NULL,
  `resourceLimitsJson` json NOT NULL,
  `secretPolicyJson` json NOT NULL,
  `lifecycleState` enum('active','archived','deleted') NOT NULL DEFAULT 'active',
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11EnvironmentDefinition_tenant_key_uq`(`tenantId`,`environmentKey`),
  KEY `V11EnvironmentDefinition_tenant_lifecycle_updated_idx`(`tenantId`,`lifecycleState`,`updatedAt`),
  KEY `V11EnvironmentDefinition_tenant_type_idx`(`tenantId`,`environmentType`),
  CONSTRAINT `V11EnvironmentDefinition_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11EnvironmentLease` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `environmentDefinitionId` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `attemptId` varchar(36) NOT NULL,
  `deviceId` varchar(36) NULL,
  `workerRef` varchar(256) NULL,
  `leaseState` enum('allocated','active','releasing','released','expired','lost') NOT NULL DEFAULT 'allocated',
  `capabilitiesJson` json NULL,
  `allocatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastHeartbeatAt` datetime(3) NULL,
  `releasedAt` datetime(3) NULL,
  `expiresAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11EnvironmentLease_invocation_attempt_uq`(`invocationId`,`attemptId`),
  KEY `V11EnvironmentLease_tenant_state_idx`(`tenantId`,`leaseState`),
  KEY `V11EnvironmentLease_definition_idx`(`environmentDefinitionId`),
  KEY `V11EnvironmentLease_device_idx`(`deviceId`),
  CONSTRAINT `V11EnvironmentLease_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11EnvironmentLease_environmentDefinitionId_fk` FOREIGN KEY (`environmentDefinitionId`) REFERENCES `V11EnvironmentDefinition`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `V11EnvironmentLease_invocationId_fk` FOREIGN KEY (`invocationId`) REFERENCES `V11Invocation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11EnvironmentChangeRequest` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `threadId` varchar(36) NOT NULL,
  `invocationId` varchar(36) NULL,
  `fromEnvironmentDefinitionId` varchar(36) NOT NULL,
  `requestedEnvironmentDefinitionId` varchar(36) NOT NULL,
  `requestedDeviceId` varchar(36) NULL,
  `requestState` enum('pending','accepted_for_next_invocation','runtime_acknowledged','rejected','expired') NOT NULL DEFAULT 'pending',
  `reasonCode` varchar(128) NULL,
  `requestedBy` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolvedAt` datetime(3) NULL,
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  KEY `V11EnvironmentChangeRequest_tenant_thread_state_idx`(`tenantId`,`threadId`,`requestState`),
  KEY `V11EnvironmentChangeRequest_tenant_invocation_idx`(`tenantId`,`invocationId`),
  KEY `V11EnvironmentChangeRequest_from_definition_idx`(`fromEnvironmentDefinitionId`),
  KEY `V11EnvironmentChangeRequest_requested_definition_idx`(`requestedEnvironmentDefinitionId`),
  CONSTRAINT `V11EnvironmentChangeRequest_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11EnvironmentChangeRequest_fromEnvironmentDefinitionId_fk` FOREIGN KEY (`fromEnvironmentDefinitionId`) REFERENCES `V11EnvironmentDefinition`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `V11EnvironmentChangeRequest_requestedEnvironmentDefinitionId_fk` FOREIGN KEY (`requestedEnvironmentDefinitionId`) REFERENCES `V11EnvironmentDefinition`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
