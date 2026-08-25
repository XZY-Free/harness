-- Batch 1：Opaque Governed Agent 的 AgentDescriptorSnapshot 登记（docs/V12/01/agent补充/00 §6.2 / 01 §2）。
--
-- 变更：
-- 1. 新增 AgentDescriptorSnapshot 表 —— SnowHarness 接受的 Agent 外部合同（Descriptor / Agent Card）
--    的一次不可变快照（Identity / CapabilityManifest / InvocationContextContract + Protocol Facts）。
-- 2. AgentRevision 新增 agentDescriptorSnapshotId 列 —— 绑定的不可变 DescriptorSnapshot（逻辑外键）。
--
-- 注：drizzle-kit MySQL 不将 .check() 约束作为可迁移变更（见 0004 头注），因此本迁移不包含任何
-- CHECK 约束；MemoryCandidate / ExecutionBinding 的 CHECK 由手写迁移独立落地，不在本迁移范围内。
CREATE TABLE `AgentDescriptorSnapshot` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`descriptorKind` varchar(32) NOT NULL,
	`protocolType` varchar(32) NOT NULL,
	`protocolContractRevision` varchar(128) NOT NULL,
	`canonicalProviderDescriptor` json NOT NULL,
	`providerDescriptorDigest` varchar(71) NOT NULL,
	`normalizedCapabilityManifest` json NOT NULL,
	`capabilityManifestDigest` varchar(71) NOT NULL,
	`invocationContextContract` json NOT NULL,
	`invocationContextContractDigest` varchar(71) NOT NULL,
	`providerDeclaredRevisionRef` varchar(128),
	`contractSectionProvenance` json NOT NULL,
	`capturedAt` datetime(3) NOT NULL,
	`createdBy` varchar(128) NOT NULL,
	CONSTRAINT `AgentDescriptorSnapshot_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `AgentRevision` ADD `agentDescriptorSnapshotId` varchar(36);--> statement-breakpoint
ALTER TABLE `AgentDescriptorSnapshot` ADD CONSTRAINT `AgentDescriptorSnapshot_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentDescriptorSnapshot` ADD CONSTRAINT `AgentDescriptorSnapshot_agentId_Agent_id_fk` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `AgentDescriptorSnapshot_tenant_agent_idx` ON `AgentDescriptorSnapshot` (`tenantId`,`agentId`);--> statement-breakpoint
CREATE INDEX `AgentDescriptorSnapshot_agent_idx` ON `AgentDescriptorSnapshot` (`agentId`);
