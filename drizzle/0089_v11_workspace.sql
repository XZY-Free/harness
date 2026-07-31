-- V11 Stage 8 S08-C01: workspace / workspace_binding /
-- workspace_attachment / workspace_attachment_use
--
-- 事实源：lib/v11/schema/workspace.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §7.1（workspace/binding/attachment）、
--         ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §9—16（执行位置语义）、
--         ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W01。
--
-- 关键约束：
-- - UNIQUE(tenantId, workspaceKey)：租户内 Workspace 稳定身份。
-- - Desktop binding 必须同时有 deviceId 和 locationRef（应用层校验，DB 不强制 NOT NULL 因 Cloud/Remote 允许 deviceId 为 null）。
-- - workspace_attachment 是 Thread 级受限资源，不改变默认 Workspace。
-- - UNIQUE(turnId, workspaceAttachmentId)：同一 Turn 不重复引用同一 Attachment。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
-- - workspaceId/threadId/workspaceBindingId 外键 ON DELETE CASCADE，级联清理。
-- - deviceId 外键 → Device(id) ON DELETE RESTRICT（防止设备被删时 binding 悬空）。
CREATE TABLE `V11Workspace` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `ownerUserId` varchar(36) NULL,
  `workspaceKey` varchar(128) NOT NULL,
  `displayName` varchar(256) NOT NULL,
  `description` text NULL,
  `workspaceKind` enum('personal','project','shared','system') NOT NULL DEFAULT 'personal',
  `lifecycleState` enum('active','archived','deleted') NOT NULL DEFAULT 'active',
  `defaultEnvironmentDefinitionId` varchar(36) NULL,
  `defaultBindingId` varchar(36) NULL,
  `versionNo` varchar(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11Workspace_tenant_key_uq`(`tenantId`,`workspaceKey`),
  KEY `V11Workspace_tenant_owner_idx`(`tenantId`,`ownerUserId`),
  KEY `V11Workspace_tenant_lifecycle_idx`(`tenantId`,`lifecycleState`),
  CONSTRAINT `V11Workspace_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11WorkspaceBinding` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `workspaceId` varchar(36) NOT NULL,
  `bindingType` enum('desktop','cloud','remote','sandbox') NOT NULL,
  `deviceId` varchar(36) NULL,
  `environmentDefinitionId` varchar(36) NULL,
  `locationRef` varchar(512) NOT NULL,
  `locationFingerprint` varchar(128) NULL,
  `bindingState` enum('active','inactive','revoked') NOT NULL DEFAULT 'active',
  `lastVerifiedAt` datetime(3) NULL,
  `versionNo` varchar(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  KEY `V11WorkspaceBinding_tenant_workspace_idx`(`tenantId`,`workspaceId`),
  KEY `V11WorkspaceBinding_tenant_device_idx`(`tenantId`,`deviceId`),
  KEY `V11WorkspaceBinding_tenant_state_idx`(`tenantId`,`bindingState`),
  CONSTRAINT `V11WorkspaceBinding_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11WorkspaceBinding_workspaceId_fk` FOREIGN KEY (`workspaceId`) REFERENCES `V11Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11WorkspaceBinding_deviceId_fk` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11WorkspaceAttachment` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `threadId` varchar(36) NOT NULL,
  `workspaceBindingId` varchar(36) NOT NULL,
  `resourceType` enum('file','directory','archive','database_snapshot','external_ref') NOT NULL,
  `resourceRef` varchar(512) NOT NULL,
  `resourceFingerprint` varchar(128) NULL,
  `displayRef` varchar(256) NULL,
  `accessMode` enum('read','read_write') NOT NULL DEFAULT 'read',
  `attachmentState` enum('attached','detached','expired') NOT NULL DEFAULT 'attached',
  `attachedBy` varchar(128) NOT NULL,
  `versionNo` varchar(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  KEY `V11WorkspaceAttachment_tenant_thread_idx`(`tenantId`,`threadId`),
  KEY `V11WorkspaceAttachment_tenant_binding_idx`(`tenantId`,`workspaceBindingId`),
  KEY `V11WorkspaceAttachment_tenant_state_idx`(`tenantId`,`attachmentState`),
  CONSTRAINT `V11WorkspaceAttachment_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11WorkspaceAttachment_threadId_fk` FOREIGN KEY (`threadId`) REFERENCES `V11Thread`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11WorkspaceAttachment_workspaceBindingId_fk` FOREIGN KEY (`workspaceBindingId`) REFERENCES `V11WorkspaceBinding`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11WorkspaceAttachmentUse` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `turnId` varchar(36) NOT NULL,
  `workspaceAttachmentId` varchar(36) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11WorkspaceAttachmentUse_turn_attachment_uq`(`turnId`,`workspaceAttachmentId`),
  KEY `V11WorkspaceAttachmentUse_tenant_turn_idx`(`tenantId`,`turnId`),
  KEY `V11WorkspaceAttachmentUse_tenant_attachment_idx`(`tenantId`,`workspaceAttachmentId`),
  CONSTRAINT `V11WorkspaceAttachmentUse_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11WorkspaceAttachmentUse_workspaceAttachmentId_fk` FOREIGN KEY (`workspaceAttachmentId`) REFERENCES `V11WorkspaceAttachment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
