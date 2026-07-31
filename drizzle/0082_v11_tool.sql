-- V11 Stage 6 S06-C02: connection / credential_ref / tool_provider / tool / tool_schema_revision
-- （ToolProvider/Tool/SchemaRevision 与迁移）
--
-- 事实源：lib/v11/schema/tool.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §4.4（能力和治理表）、
--         ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §4（Tool）、§8（MCP）、
--         ../v11-agentkit-platform/12-capability-and-collaboration-api.md §3.2（读取 Tool Schema）。
--
-- 关键约束：
-- - UNIQUE(tenantId, connectionKey)：租户内 Connection key 唯一（正则 `^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符，应用层校验）。
-- - UNIQUE(tenantId, providerKey)：租户内 ToolProvider key 唯一。
-- - UNIQUE(tenantId, providerId, toolKey)：Provider 内 Tool key 唯一。
-- - UNIQUE(toolId, revisionNo)：Tool 内 SchemaRevision 号单调递增。
-- - published SchemaRevision 业务内容不可修改；只能新建版本。
-- - withdrawn 只阻止新发布或路由，不删除历史引用。
-- - currentSchemaRevisionId 必须指向同一 Tool 的 published SchemaRevision（逻辑外键，应用层校验）。
-- - schemaHash / fingerprint 必须以 `sha256:` 前缀存储（应用层校验）。
-- - CredentialRef 不存密文，只保存 Vault 引用 + 指纹。
CREATE TABLE `V11Connection` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `connectionKey` varchar(128) NOT NULL,
  `connectionType` varchar(32) NOT NULL,
  `endpointRef` varchar(512) NULL,
  `authMethod` varchar(32) NOT NULL DEFAULT 'none',
  `ownerUserId` varchar(36) NOT NULL,
  `lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11Connection_tenant_connectionKey_uq`(`tenantId`,`connectionKey`),
  KEY `V11Connection_tenant_lifecycle_updated_idx`(`tenantId`,`lifecycleState`,`updatedAt`),
  CONSTRAINT `V11Connection_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11CredentialRef` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `connectionId` varchar(36) NULL,
  `provider` varchar(64) NOT NULL,
  `vaultRef` varchar(512) NOT NULL,
  `fingerprint` varchar(128) NOT NULL,
  `scopeJson` json NULL,
  `expiresAt` datetime(3) NULL,
  `lifecycleState` enum('active','rotated','revoked') NOT NULL DEFAULT 'active',
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  KEY `V11CredentialRef_tenant_connectionId_idx`(`tenantId`,`connectionId`),
  KEY `V11CredentialRef_tenant_fingerprint_idx`(`tenantId`,`fingerprint`),
  CONSTRAINT `V11CredentialRef_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11CredentialRef_connectionId_fk` FOREIGN KEY (`connectionId`) REFERENCES `V11Connection`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11ToolProvider` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `providerKey` varchar(128) NOT NULL,
  `providerType` varchar(32) NOT NULL,
  `connectionId` varchar(36) NULL,
  `trustLevel` varchar(32) NOT NULL DEFAULT 'standard',
  `displayName` varchar(256) NOT NULL,
  `description` text NULL,
  `ownerUserId` varchar(36) NOT NULL,
  `lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11ToolProvider_tenant_providerKey_uq`(`tenantId`,`providerKey`),
  KEY `V11ToolProvider_tenant_providerType_lifecycle_idx`(`tenantId`,`providerType`,`lifecycleState`),
  CONSTRAINT `V11ToolProvider_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11ToolProvider_connectionId_fk` FOREIGN KEY (`connectionId`) REFERENCES `V11Connection`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11Tool` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `providerId` varchar(36) NOT NULL,
  `toolKey` varchar(128) NOT NULL,
  `displayName` varchar(256) NOT NULL,
  `description` text NULL,
  `riskClass` varchar(32) NOT NULL DEFAULT 'medium',
  `currentSchemaRevisionId` varchar(36) NULL,
  `lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11Tool_tenant_providerId_toolKey_uq`(`tenantId`,`providerId`,`toolKey`),
  KEY `V11Tool_tenant_lifecycle_riskClass_idx`(`tenantId`,`lifecycleState`,`riskClass`),
  CONSTRAINT `V11Tool_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11Tool_providerId_fk` FOREIGN KEY (`providerId`) REFERENCES `V11ToolProvider`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11ToolSchemaRevision` (
  `id` varchar(36) NOT NULL,
  `toolId` varchar(36) NOT NULL,
  `revisionNo` bigint NOT NULL,
  `description` text NULL,
  `inputSchemaJson` json NOT NULL,
  `outputSchemaJson` json NULL,
  `schemaHash` varchar(128) NOT NULL,
  `riskMetadataJson` json NULL,
  `revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
  `createdBy` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `publishedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11ToolSchemaRevision_tool_revisionNo_uq`(`toolId`,`revisionNo`),
  KEY `V11ToolSchemaRevision_tool_state_idx`(`toolId`,`revisionState`),
  CONSTRAINT `V11ToolSchemaRevision_toolId_fk` FOREIGN KEY (`toolId`) REFERENCES `V11Tool`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
