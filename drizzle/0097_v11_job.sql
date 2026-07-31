-- V11 Stage 9 S09-C04: V11Job / V11JobEvent / V11JobCommand / V11JobResultProjection
--
-- 事实源：lib/v11/schema/job.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §6.1（Job 表）、§6.1 文末（JobEvent）、
--           §6.12（JobCommand）、§5.4（job_result Item 关联 job_result_projection）、§9（事务边界）、
--         ../v11-agentkit-platform/13-memory-and-job-api.md §4（Job Control API）、
--         ../v11-agentkit-platform/09-unified-domain-model.md §5.2、§5.3（域模型：Job 与会话分离）、
--         ../v11-agentkit-platform/contracts/event-catalog.json（18 个 job.* 事件）、
--         ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md
--           S09-W04（Job 与 JobEvent）、S09-C04。
--
-- 关键约束：
-- - Job 不复活：终态 Job 不能改回 queued；retry 必须创建新 replacement Job 并通过 replaces_job_id 引用。
-- - JobEvent sequence 通过锁定 Job.last_event_sequence 原子递增（不用 max+1）。
-- - JobEvent UNIQUE(jobId, eventSequence) + UNIQUE(jobId, idempotencyKey)（idempotencyKey 非空时）。
-- - JobCommand UNIQUE(jobId, idempotencyKey)。
-- - 一个 Invocation 必须且只能属于一个 Turn 或一个 Job（V11Invocation 表已有 jobId 字段）。
-- - Job 创建只能来自所属领域服务；不提供通用 POST /jobs 入口。
-- - JobEvent 不出现在员工 Thread SSE；只有 job_result projection 才进入 ThreadEvent。
-- - completion_policy_json 决定整个 Job 终态；单 Invocation 终态只写 job.invocation_*。
-- - 跨租户隔离：所有查询按 tenantId 过滤；tenantId 外键 → Tenant(id) ON DELETE CASCADE。
CREATE TABLE `V11Job` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `agentId` varchar(36) NOT NULL,
  `jobType` enum('scheduled','batch','deployment','evaluation','knowledge_build','system') NOT NULL,
  `triggerRef` varchar(256) NOT NULL,
  `jobState` enum('queued','running','waiting_external','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
  `replacesJobId` varchar(36) NULL,
  `threadId` varchar(36) NULL,
  `completionPolicyJson` json NOT NULL,
  `inputRef` varchar(512) NULL,
  `inputHash` varchar(128) NULL,
  `lastEventSequence` bigint NOT NULL DEFAULT 0,
  `resultRef` varchar(512) NULL,
  `resultHash` varchar(128) NULL,
  `errorCode` varchar(128) NULL,
  `errorSummary` text NULL,
  `createdBy` varchar(36) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `startedAt` datetime(3) NULL,
  `finishedAt` datetime(3) NULL,
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `versionNo` bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(`id`),
  KEY `V11Job_tenant_agent_idx`(`tenantId`,`agentId`),
  KEY `V11Job_tenant_state_idx`(`tenantId`,`jobState`),
  KEY `V11Job_tenant_thread_idx`(`tenantId`,`threadId`),
  KEY `V11Job_tenant_replaces_idx`(`tenantId`,`replacesJobId`),
  KEY `V11Job_tenant_type_state_idx`(`tenantId`,`jobType`,`jobState`),
  CONSTRAINT `V11Job_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11JobEvent` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `jobId` varchar(36) NOT NULL,
  `eventSequence` bigint NOT NULL,
  `eventType` enum('job.queued','job.started','job.progress_updated','job.result_recorded','job.waiting','job.cancel_requested','job.retry_requested','job.completed','job.failed','job.cancelled','job.invocation_queued','job.invocation_started','job.invocation_waiting','job.invocation_resumed','job.invocation_completed','job.invocation_failed','job.invocation_cancelled','job.invocation_lost') NOT NULL,
  `schemaVersion` int NOT NULL DEFAULT 1,
  `invocationId` varchar(36) NULL,
  `actorType` enum('user','agent','system','tool','service') NOT NULL,
  `actorId` varchar(36) NULL,
  `payloadJson` json NOT NULL,
  `correlationId` varchar(128) NULL,
  `causationId` varchar(128) NULL,
  `idempotencyKey` varchar(128) NULL,
  `occurredAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `ingestedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11JobEvent_job_sequence_uq`(`jobId`,`eventSequence`),
  UNIQUE KEY `V11JobEvent_job_idempotency_uq`(`jobId`,`idempotencyKey`),
  KEY `V11JobEvent_tenant_job_idx`(`tenantId`,`jobId`),
  KEY `V11JobEvent_tenant_job_invocation_idx`(`tenantId`,`jobId`,`invocationId`),
  KEY `V11JobEvent_tenant_job_occurred_idx`(`tenantId`,`jobId`,`occurredAt`),
  CONSTRAINT `V11JobEvent_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11JobCommand` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `jobId` varchar(36) NOT NULL,
  `commandType` enum('cancel','retry') NOT NULL,
  `commandState` enum('queued','dispatched','acknowledged','rejected') NOT NULL DEFAULT 'queued',
  `idempotencyKey` varchar(128) NULL,
  `requestedBy` varchar(36) NULL,
  `reasonCode` varchar(128) NULL,
  `replacementJobId` varchar(36) NULL,
  `errorCode` varchar(128) NULL,
  `errorSummary` text NULL,
  `commandPayloadJson` json NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `dispatchedAt` datetime(3) NULL,
  `acknowledgedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11JobCommand_job_idempotency_uq`(`jobId`,`idempotencyKey`),
  KEY `V11JobCommand_tenant_job_state_idx`(`tenantId`,`jobId`,`commandState`),
  KEY `V11JobCommand_tenant_replacement_idx`(`tenantId`,`replacementJobId`),
  CONSTRAINT `V11JobCommand_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11JobResultProjection` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `itemId` varchar(36) NOT NULL,
  `jobId` varchar(36) NOT NULL,
  `sourceTurnId` varchar(36) NOT NULL,
  `projectionKind` enum('existing_source_turn','system_triggered_turn') NOT NULL,
  `resultRef` varchar(512) NOT NULL,
  `resultHash` varchar(128) NOT NULL,
  `resultSummaryJson` json NULL,
  `createdBy` varchar(36) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11JobResultProjection_item_uq`(`itemId`),
  KEY `V11JobResultProjection_tenant_job_idx`(`tenantId`,`jobId`),
  KEY `V11JobResultProjection_tenant_source_turn_idx`(`tenantId`,`sourceTurnId`),
  CONSTRAINT `V11JobResultProjection_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
