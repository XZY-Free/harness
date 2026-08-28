CREATE TABLE `AgentCallAttempt` (
	`id` varchar(36) NOT NULL,
	`callId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`attemptNo` int NOT NULL,
	`attemptState` enum('queued','running','completed','failed','cancelled','lost') NOT NULL DEFAULT 'queued',
	`externalTaskRef` varchar(256),
	`dispatchAttemptCount` int NOT NULL DEFAULT 0,
	`retryReasonCode` varchar(64),
	`startedAt` datetime(3),
	`finishedAt` datetime(3),
	`errorCode` varchar(128),
	`errorSummary` text,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `AgentCallAttempt_id` PRIMARY KEY(`id`),
	CONSTRAINT `AgentCallAttempt_call_attempt_uq` UNIQUE(`callId`,`attemptNo`)
);
--> statement-breakpoint
CREATE TABLE `AgentCallBinding` (
	`callId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`agentRevisionId` varchar(36) NOT NULL,
	`agentContractSnapshotId` varchar(36) NOT NULL,
	`agentContractDigest` varchar(71) NOT NULL,
	`agentCapabilityDigest` varchar(71) NOT NULL,
	`agentContextDigest` varchar(71) NOT NULL,
	`agentPublicationRecordId` varchar(36) NOT NULL,
	`deploymentRouteId` varchar(36) NOT NULL,
	`routeRevisionId` varchar(36) NOT NULL,
	`routeActivationId` varchar(36) NOT NULL,
	`routeContentDigest` varchar(71) NOT NULL,
	`resolutionInputDigest` varchar(71) NOT NULL,
	`projectionVersionNo` int NOT NULL,
	`endpointRef` varchar(512) NOT NULL,
	`identityMode` enum('none','bearer') NOT NULL,
	`credentialRefId` varchar(36),
	`networkZone` varchar(32) NOT NULL,
	`protocolType` varchar(32) NOT NULL,
	`protocolContractRevision` varchar(128) NOT NULL,
	`policyRevisionId` varchar(36) NOT NULL,
	`policyRulesDigest` varchar(71) NOT NULL,
	`governanceConfigRevisionId` varchar(36) NOT NULL,
	`governanceConfigDigest` varchar(71) NOT NULL,
	`bindingHash` varchar(128) NOT NULL,
	`boundAt` datetime(3) NOT NULL,
	CONSTRAINT `AgentCallBinding_callId` PRIMARY KEY(`callId`)
);
--> statement-breakpoint
CREATE TABLE `AgentCallEventIngress` (
	`id` varchar(36) NOT NULL,
	`callId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`producerEventId` varchar(128) NOT NULL,
	`producerSequence` bigint NOT NULL,
	`candidateType` varchar(64) NOT NULL,
	`payloadHash` varchar(128) NOT NULL,
	`payloadJson` json,
	`ingressState` enum('accepted','mapped','rejected') NOT NULL DEFAULT 'accepted',
	`receivedAt` datetime(3) NOT NULL,
	`mappedAt` datetime(3),
	`rejectedReason` varchar(256),
	CONSTRAINT `AgentCallEventIngress_id` PRIMARY KEY(`id`),
	CONSTRAINT `AgentCallEventIngress_call_producer_event_uq` UNIQUE(`callId`,`producerEventId`),
	CONSTRAINT `AgentCallEventIngress_call_producer_seq_uq` UNIQUE(`callId`,`producerSequence`)
);
--> statement-breakpoint
CREATE TABLE `AgentCall` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`parentInvocationId` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`agentRevisionId` varchar(36) NOT NULL,
	`sourceType` varchar(32) NOT NULL,
	`sourceRef` varchar(256),
	`state` enum('queued','running','waiting_user','completed','failed','cancelled','lost') NOT NULL DEFAULT 'queued',
	`externalContextRef` varchar(256),
	`externalTaskRef` varchar(256),
	`resultText` text,
	`resultJson` json,
	`resultDigest` varchar(71),
	`errorCode` varchar(128),
	`errorSummary` text,
	`logicalCallKey` varchar(256),
	`createdAt` datetime(3) NOT NULL,
	`startedAt` datetime(3),
	`waitingAt` datetime(3),
	`finishedAt` datetime(3),
	`versionNo` bigint NOT NULL DEFAULT 1,
	CONSTRAINT `AgentCall_id` PRIMARY KEY(`id`),
	CONSTRAINT `AgentCall_parent_logical_key_uq` UNIQUE(`parentInvocationId`,`logicalCallKey`)
);
--> statement-breakpoint
CREATE TABLE `AgentSessionBinding` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`agentRevisionId` varchar(36) NOT NULL,
	`deploymentRouteId` varchar(36) NOT NULL,
	`routeRevisionId` varchar(36) NOT NULL,
	`externalContextRef` varchar(256) NOT NULL,
	`bindingState` enum('active','closed','lost') NOT NULL DEFAULT 'active',
	`createdAt` datetime(3) NOT NULL,
	`lastUsedAt` datetime(3) NOT NULL,
	`closedAt` datetime(3),
	CONSTRAINT `AgentSessionBinding_id` PRIMARY KEY(`id`),
	CONSTRAINT `AgentSessionBinding_revision_route_context_uq` UNIQUE(`agentRevisionId`,`routeRevisionId`,`externalContextRef`)
);
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` MODIFY COLUMN `targetKind` enum('runtime','agent') NOT NULL DEFAULT 'runtime';--> statement-breakpoint
ALTER TABLE `AgentCallAttempt` ADD CONSTRAINT `AgentCallAttempt_callId_AgentCall_id_fk` FOREIGN KEY (`callId`) REFERENCES `AgentCall`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentCallBinding` ADD CONSTRAINT `AgentCallBinding_callId_AgentCall_id_fk` FOREIGN KEY (`callId`) REFERENCES `AgentCall`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` ADD CONSTRAINT `AgentCallEventIngress_callId_AgentCall_id_fk` FOREIGN KEY (`callId`) REFERENCES `AgentCall`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentCall` ADD CONSTRAINT `AgentCall_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentCall` ADD CONSTRAINT `AgentCall_parentInvocationId_Invocation_id_fk` FOREIGN KEY (`parentInvocationId`) REFERENCES `Invocation`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentSessionBinding` ADD CONSTRAINT `AgentSessionBinding_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `AgentCallAttempt_call_state_idx` ON `AgentCallAttempt` (`callId`,`attemptState`);--> statement-breakpoint
CREATE INDEX `AgentCallBinding_tenant_idx` ON `AgentCallBinding` (`tenantId`);--> statement-breakpoint
CREATE INDEX `AgentCallBinding_agentRevision_idx` ON `AgentCallBinding` (`agentRevisionId`);--> statement-breakpoint
CREATE INDEX `AgentCallBinding_routeRevision_idx` ON `AgentCallBinding` (`routeRevisionId`);--> statement-breakpoint
CREATE INDEX `AgentCallEventIngress_call_state_idx` ON `AgentCallEventIngress` (`callId`,`ingressState`);--> statement-breakpoint
CREATE INDEX `AgentCall_tenant_state_idx` ON `AgentCall` (`tenantId`,`state`);--> statement-breakpoint
CREATE INDEX `AgentCall_parent_idx` ON `AgentCall` (`parentInvocationId`);--> statement-breakpoint
CREATE INDEX `AgentCall_agent_idx` ON `AgentCall` (`agentId`);--> statement-breakpoint
CREATE INDEX `AgentSessionBinding_thread_idx` ON `AgentSessionBinding` (`threadId`);--> statement-breakpoint
CREATE INDEX `AgentSessionBinding_agent_idx` ON `AgentSessionBinding` (`agentId`);