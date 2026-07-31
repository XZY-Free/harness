-- V11 Stage 8 S08-C03: permission_decision / grant
--
-- 事实源：lib/v11/schema/permission.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §6.8（permission_decision、
--         user_action_request 与 grant）、§5.5（ToolCall、Effect 与 Credential）、
--         ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W03。
--
-- 关键约束：
-- - UNIQUE(toolCallId, decisionSequence)：同一 ToolCall 多次评估依次递增。
-- - decision=block 不创建可绕过的 UserActionRequest（应用层校验）。
-- - Grant.scope 必须覆盖当前 ToolCall 所需 scope（应用层校验）。
-- - Grant 撤销/过期后不可注入（grantState=revoked/expired 视为失效）。
-- - Grant.credentialRefId 外键 → V11CredentialRef(id) ON DELETE RESTRICT
--   （防止 CredentialRef 删除时 Grant 变孤儿）。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
CREATE TABLE `V11PermissionDecision` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `toolCallId` varchar(36) NOT NULL,
  `decisionSequence` int NOT NULL,
  `decision` enum('allow','pause','block') NOT NULL,
  `policyRevisionId` varchar(36) NULL,
  `reasonCodesJson` json NOT NULL,
  `riskSummaryJson` json NULL,
  `decisionSummary` text NULL,
  `decidedBy` varchar(128) NOT NULL,
  `decidedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11PermissionDecision_toolCall_sequence_uq`(`toolCallId`,`decisionSequence`),
  KEY `V11PermissionDecision_tenant_toolCall_idx`(`tenantId`,`toolCallId`),
  KEY `V11PermissionDecision_tenant_decision_idx`(`tenantId`,`decision`),
  CONSTRAINT `V11PermissionDecision_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11Grant` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `userId` varchar(36) NOT NULL,
  `grantType` enum('user_consent','policy','admin_override') NOT NULL,
  `scopeJson` json NOT NULL,
  `credentialRefId` varchar(36) NOT NULL,
  `issuedBy` varchar(128) NOT NULL,
  `issuedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` datetime(3) NULL,
  `revokedAt` datetime(3) NULL,
  `revokeReasonCode` varchar(64) NULL,
  `grantState` enum('active','revoked','expired') NOT NULL DEFAULT 'active',
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  KEY `V11Grant_tenant_user_state_idx`(`tenantId`,`userId`,`grantState`),
  KEY `V11Grant_tenant_credential_idx`(`tenantId`,`credentialRefId`),
  KEY `V11Grant_tenant_state_expires_idx`(`tenantId`,`grantState`,`expiresAt`),
  CONSTRAINT `V11Grant_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11Grant_credentialRefId_fk` FOREIGN KEY (`credentialRefId`) REFERENCES `V11CredentialRef`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
