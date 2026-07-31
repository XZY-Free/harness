-- V11 Stage 5 S05-C01: invocation, execution_binding, invocation_attempt, execution_ownership
--
-- 事实源：lib/v11/schema/runtime.ts、
--         docs/solutions/v11-agentkit-platform/10-core-data-model.md
--           §6.2（Invocation L366-387）、§6.3（ExecutionBinding L405-423）、
--           §6.4（InvocationAttempt L389-403）、§6.13（ExecutionOwnership L516-523）
--
-- 关键约束：
-- - turnId/jobId 恰有一个非空（应用层校验，DB 不加 CHECK）。
-- - ExecutionBinding 启动后不可变（invocationId 为主键，1:1，无 update）。
-- - Attempt 只表示整个 Invocation 基础设施重调度（不表示模型 Span、ToolCall）。
-- - Regenerate 创建新 Invocation 仍属于原 Turn。
-- - leaseEpoch 单调递增，每次新获取执行权时 +1。
CREATE TABLE `V11Invocation` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `threadId` varchar(36) NULL,
  `turnId` varchar(36) NULL,
  `jobId` varchar(36) NULL,
  `invocationSequence` bigint NOT NULL,
  `invocationKind` enum('initial','regenerate','job') NOT NULL,
  `executionState` enum('queued','running','waiting_user','completed','failed','cancelled','lost') NOT NULL DEFAULT 'queued',
  `triggerItemId` varchar(36) NULL,
  `replacesInvocationId` varchar(36) NULL,
  `outputItemId` varchar(36) NULL,
  `resultRef` varchar(512) NULL,
  `runtimeSessionBindingId` varchar(36) NULL,
  `runtimeExecutionRef` varchar(256) NULL,
  `startedAt` datetime(3) NULL,
  `finishedAt` datetime(3) NULL,
  `lastHeartbeatAt` datetime(3) NULL,
  `errorCode` varchar(128) NULL,
  `errorSummary` text NULL,
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11Invocation_thread_sequence_uq`(`threadId`,`invocationSequence`),
  UNIQUE KEY `V11Invocation_job_sequence_uq`(`jobId`,`invocationSequence`),
  KEY `V11Invocation_tenant_state_idx`(`tenantId`,`executionState`),
  KEY `V11Invocation_turn_idx`(`turnId`),
  CONSTRAINT `V11Invocation_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11ExecutionBinding` (
  `invocationId` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `agentRevisionId` varchar(36) NOT NULL,
  `runtimeRevisionId` varchar(36) NOT NULL,
  `deploymentRouteId` varchar(36) NOT NULL,
  `modelProvider` varchar(128) NOT NULL,
  `modelId` varchar(256) NOT NULL,
  `modelRevisionRef` varchar(256) NULL,
  `initialEnvironmentLeaseId` varchar(36) NULL,
  `workspaceBindingId` varchar(36) NULL,
  `policyRevisionId` varchar(36) NULL,
  `contextCheckpointId` varchar(36) NULL,
  `configHash` varchar(128) NOT NULL,
  `boundAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`invocationId`),
  KEY `V11ExecutionBinding_tenant_idx`(`tenantId`),
  KEY `V11ExecutionBinding_agentRevision_idx`(`agentRevisionId`),
  KEY `V11ExecutionBinding_runtimeRevision_idx`(`runtimeRevisionId`),
  CONSTRAINT `V11ExecutionBinding_invocationId_fk` FOREIGN KEY (`invocationId`) REFERENCES `V11Invocation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11InvocationAttempt` (
  `id` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `attemptNo` int NOT NULL,
  `attemptState` enum('queued','running','completed','failed','cancelled','lost') NOT NULL DEFAULT 'queued',
  `environmentLeaseId` varchar(36) NULL,
  `workerRef` varchar(256) NULL,
  `runtimeExecutionRef` varchar(256) NULL,
  `checkpointRef` varchar(512) NULL,
  `retryReasonCode` varchar(64) NULL,
  `startedAt` datetime(3) NULL,
  `finishedAt` datetime(3) NULL,
  `lastHeartbeatAt` datetime(3) NULL,
  `errorCode` varchar(128) NULL,
  `errorSummary` text NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11InvocationAttempt_invocation_attempt_uq`(`invocationId`,`attemptNo`),
  KEY `V11InvocationAttempt_invocation_state_idx`(`invocationId`,`attemptState`),
  CONSTRAINT `V11InvocationAttempt_invocationId_fk` FOREIGN KEY (`invocationId`) REFERENCES `V11Invocation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11ExecutionOwnership` (
  `id` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `deviceId` varchar(36) NULL,
  `environmentLeaseId` varchar(36) NULL,
  `ownershipState` enum('active','released','lost') NOT NULL DEFAULT 'active',
  `leaseEpoch` bigint NOT NULL,
  `acquiredAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastHeartbeatAt` datetime(3) NULL,
  `releasedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11ExecutionOwnership_invocation_epoch_uq`(`invocationId`,`leaseEpoch`),
  KEY `V11ExecutionOwnership_invocation_state_idx`(`invocationId`,`ownershipState`)
) ENGINE=InnoDB;
