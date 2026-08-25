CREATE TABLE `AgentContractCapability` (
	`id` varchar(36) NOT NULL,
	`snapshotId` varchar(36) NOT NULL,
	`position` bigint NOT NULL,
	`key` varchar(128) NOT NULL,
	`nameZhCn` varchar(256) NOT NULL,
	`nameEn` varchar(256),
	`descriptionZhCn` text,
	`descriptionEn` text,
	`tags` json NOT NULL,
	`examples` json NOT NULL,
	`inputModes` json NOT NULL,
	`outputModes` json NOT NULL,
	CONSTRAINT `AgentContractCapability_id` PRIMARY KEY(`id`),
	CONSTRAINT `AgentContractCapability_snapshot_position_uq` UNIQUE(`snapshotId`,`position`),
	CONSTRAINT `AgentContractCapability_snapshot_key_uq` UNIQUE(`snapshotId`,`key`)
);
--> statement-breakpoint
CREATE TABLE `AgentContractInvocationContext` (
	`id` varchar(36) NOT NULL,
	`snapshotId` varchar(36) NOT NULL,
	`position` bigint NOT NULL,
	`key` varchar(128) NOT NULL,
	`nameZhCn` varchar(256) NOT NULL,
	`nameEn` varchar(256),
	`descriptionZhCn` text,
	`descriptionEn` text,
	`necessity` enum('required','preferred','accepted') NOT NULL,
	`appliesTo` json,
	`trustRequirement` varchar(64),
	`declarationSource` enum('provider_declared','operator_declared') NOT NULL,
	CONSTRAINT `AgentContractInvocationContext_id` PRIMARY KEY(`id`),
	CONSTRAINT `AgentContractInvocationContext_snapshot_position_uq` UNIQUE(`snapshotId`,`position`),
	CONSTRAINT `AgentContractInvocationContext_snapshot_key_uq` UNIQUE(`snapshotId`,`key`)
);
--> statement-breakpoint
CREATE TABLE `AgentContractSnapshot` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`contractVersion` varchar(64) NOT NULL,
	`publicAgentId` varchar(128) NOT NULL,
	`publicAgentVersion` varchar(64) NOT NULL,
	`agentNameZhCn` varchar(256) NOT NULL,
	`agentNameEn` varchar(256),
	`protocolType` varchar(32) NOT NULL,
	`protocolContractRevision` varchar(128) NOT NULL,
	`streamingTransport` boolean NOT NULL,
	`incrementalContent` boolean NOT NULL,
	`inputRequired` boolean NOT NULL,
	`resume` boolean NOT NULL,
	`cancel` boolean NOT NULL,
	`durableTaskRecovery` boolean NOT NULL,
	`supportedLocales` json NOT NULL,
	`resultFields` json NOT NULL,
	`errorCodes` json NOT NULL,
	`resultNotesZhCn` text,
	`resultNotesEn` text,
	`contractDigest` varchar(71) NOT NULL,
	`capabilityDigest` varchar(71) NOT NULL,
	`contextDigest` varchar(71) NOT NULL,
	`capturedAt` datetime(3) NOT NULL,
	`createdBy` varchar(128) NOT NULL,
	CONSTRAINT `AgentContractSnapshot_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `AgentContractCapability` ADD CONSTRAINT `AgentContractCapability_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `AgentContractSnapshot`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentContractInvocationContext` ADD CONSTRAINT `AgentContractInvocationContext_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `AgentContractSnapshot`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentContractSnapshot` ADD CONSTRAINT `AgentContractSnapshot_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentContractSnapshot` ADD CONSTRAINT `AgentContractSnapshot_agentId_Agent_id_fk` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `AgentContractSnapshot_tenant_agent_idx` ON `AgentContractSnapshot` (`tenantId`,`agentId`);--> statement-breakpoint
CREATE INDEX `AgentContractSnapshot_agent_idx` ON `AgentContractSnapshot` (`agentId`);