-- V11 Stage 8 S08-C06: artifact / file_change / filesystem_checkpoint
--
-- 事实源：lib/v11/schema/runtime-artifact.ts、lib/v11/schema/file-change.ts、
--         lib/v11/schema/filesystem-checkpoint.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §7.3-7.4、
--         §6.3（invocation_attempt.checkpoint_ref）、§6.6（tool_call.result_artifact_id）、
--         §9 不变量第 11 条（本地路径必须与 Desktop device/binding 一起解释）、
--         ../v11-agentkit-platform/11-api-and-event-boundaries.md §5.3（Artifact 上传 API）、
--         ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W06。
--
-- 关键约束：
-- - artifact：UNIQUE(itemId) 一对一；contentRef 受管引用；contentHash sha256: 前缀；
--   会话产物（threadId/turnId）与 Job 产物（jobId）互斥；写入后不可变。
-- - file_change：pathRef 相对 WorkspaceBinding；beforeHash/afterHash 按 changeType 互斥；
--   workspaceBindingId 外键 CASCADE；写入后不可变。
-- - filesystem_checkpoint：只恢复文件状态不恢复会话；workspaceBindingId 外键 CASCADE；
--   contentHash sha256: 前缀；写入后不可变。
-- - 三张表都 tenantId 外键 → Tenant(id) ON DELETE CASCADE；跨租户隔离。
-- - 与 ArtifactAttestation（控制面供应链证明，drizzle/0069_v11_artifact_attestation.sql）是不同概念。
CREATE TABLE `V11Artifact` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `threadId` varchar(36) NULL,
  `turnId` varchar(36) NULL,
  `jobId` varchar(36) NULL,
  `itemId` varchar(36) NULL,
  `artifactType` varchar(32) NOT NULL,
  `displayName` varchar(256) NOT NULL,
  `contentRef` varchar(512) NOT NULL,
  `mediaType` varchar(128) NOT NULL,
  `byteSize` bigint NOT NULL,
  `contentHash` varchar(128) NOT NULL,
  `visibilityScope` varchar(32) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11Artifact_itemId_uq`(`itemId`),
  KEY `V11Artifact_tenant_invocation_idx`(`tenantId`,`invocationId`),
  KEY `V11Artifact_tenant_thread_idx`(`tenantId`,`threadId`),
  KEY `V11Artifact_tenant_job_idx`(`tenantId`,`jobId`),
  KEY `V11Artifact_tenant_expires_idx`(`tenantId`,`expiresAt`),
  CONSTRAINT `V11Artifact_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11FileChange` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `toolCallId` varchar(36) NOT NULL,
  `workspaceBindingId` varchar(36) NOT NULL,
  `pathRef` varchar(512) NOT NULL,
  `changeType` enum('create','update','delete','rename','move') NOT NULL,
  `beforeHash` varchar(128) NULL,
  `afterHash` varchar(128) NULL,
  `artifactId` varchar(36) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  KEY `V11FileChange_tenant_toolCall_idx`(`tenantId`,`toolCallId`),
  KEY `V11FileChange_tenant_binding_idx`(`tenantId`,`workspaceBindingId`),
  KEY `V11FileChange_tenant_artifact_idx`(`tenantId`,`artifactId`),
  CONSTRAINT `V11FileChange_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11FileChange_workspaceBindingId_fk` FOREIGN KEY (`workspaceBindingId`) REFERENCES `V11WorkspaceBinding`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11FilesystemCheckpoint` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `workspaceBindingId` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `checkpointType` varchar(32) NOT NULL,
  `checkpointRef` varchar(512) NOT NULL,
  `baseRevisionRef` varchar(512) NULL,
  `contentHash` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  KEY `V11FilesystemCheckpoint_tenant_binding_idx`(`tenantId`,`workspaceBindingId`),
  KEY `V11FilesystemCheckpoint_tenant_invocation_idx`(`tenantId`,`invocationId`),
  KEY `V11FilesystemCheckpoint_tenant_expires_idx`(`tenantId`,`expiresAt`),
  CONSTRAINT `V11FilesystemCheckpoint_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11FilesystemCheckpoint_workspaceBindingId_fk` FOREIGN KEY (`workspaceBindingId`) REFERENCES `V11WorkspaceBinding`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
