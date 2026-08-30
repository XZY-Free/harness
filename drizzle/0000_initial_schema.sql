CREATE TABLE `RuntimeArtifact` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`threadId` varchar(36),
	`turnId` varchar(36),
	`jobId` varchar(36),
	`itemId` varchar(36),
	`artifactType` varchar(32) NOT NULL,
	`displayName` varchar(256) NOT NULL,
	`contentRef` varchar(512) NOT NULL,
	`mediaType` varchar(128) NOT NULL,
	`byteSize` bigint NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`visibilityScope` varchar(32) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`expiresAt` datetime(3),
	CONSTRAINT `RuntimeArtifact_id` PRIMARY KEY(`id`),
	CONSTRAINT `RuntimeArtifact_itemId_uq` UNIQUE(`itemId`)
);
--> statement-breakpoint
CREATE TABLE `admin_export` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`requested_by` varchar(128) NOT NULL,
	`request_principal_kind` varchar(16) NOT NULL,
	`export_kind` varchar(32) NOT NULL,
	`filter_json` json,
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`result_ref` varchar(512),
	`result_format` varchar(16) NOT NULL DEFAULT 'ndjson',
	`record_count` int NOT NULL DEFAULT 0,
	`redaction_summary` varchar(256),
	`failure_reason` varchar(256),
	`version_no` varchar(36) NOT NULL DEFAULT '1',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`completed_at` datetime(3),
	CONSTRAINT `admin_export_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
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
CREATE TABLE `AgentRevision` (
	`id` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`agentContractSnapshotId` varchar(36) NOT NULL,
	`revisionNo` bigint NOT NULL,
	`modelPolicyJson` json NOT NULL,
	`permissionRequirementsJson` json NOT NULL,
	`delegationPolicyJson` json NOT NULL,
	`agentInterfaceRequirementsJson` json NOT NULL,
	`revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
	`createdBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`publishedAt` datetime(3),
	CONSTRAINT `AgentRevision_id` PRIMARY KEY(`id`),
	CONSTRAINT `AgentRevision_agent_revisionNo_uq` UNIQUE(`agentId`,`revisionNo`)
);
--> statement-breakpoint
CREATE TABLE `Agent` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`agentKey` varchar(128) NOT NULL,
	`displayName` varchar(256) NOT NULL,
	`description` text,
	`ownerUserId` varchar(36) NOT NULL,
	`lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
	`currentRevisionId` varchar(36),
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime,
	CONSTRAINT `Agent_id` PRIMARY KEY(`id`),
	CONSTRAINT `Agent_tenant_agentKey_uq` UNIQUE(`tenantId`,`agentKey`)
);
--> statement-breakpoint
CREATE TABLE `AgentCallAttempt` (
	`id` varchar(36) NOT NULL,
	`callId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`attemptNo` int NOT NULL,
	`attemptState` enum('queued','running','completed','failed','cancelled','lost') NOT NULL DEFAULT 'queued',
	`externalTaskRef` varchar(256),
	`dispatchAttemptCount` int NOT NULL DEFAULT 0,
	`retryReasonCode` varchar(64),
	`requestDigest` varchar(71),
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
CREATE TABLE `AuditEvent` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`actorType` enum('user','service','workload','system') NOT NULL,
	`actorId` varchar(128) NOT NULL,
	`actionType` varchar(64) NOT NULL,
	`targetType` varchar(64) NOT NULL,
	`targetId` varchar(128),
	`beforeHash` varchar(64),
	`afterHash` varchar(64),
	`reason` text,
	`requestId` varchar(64) NOT NULL,
	`occurredAt` datetime(3) NOT NULL,
	CONSTRAINT `AuditEvent_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `RoleActionBinding` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`principalBindingId` varchar(36) NOT NULL,
	`actionCode` varchar(64) NOT NULL,
	`resourceScopeJson` text NOT NULL,
	`validFrom` datetime(3) NOT NULL,
	`validUntil` datetime(3),
	`createdAt` datetime NOT NULL,
	CONSTRAINT `RoleActionBinding_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `CapabilityUse` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`capabilityType` varchar(32) NOT NULL,
	`capabilityId` varchar(36) NOT NULL,
	`revisionId` varchar(36),
	`contentHash` varchar(128),
	`schemaHash` varchar(128),
	`sourceType` varchar(32) NOT NULL DEFAULT 'dynamic_discovery',
	`sourceRef` varchar(256),
	`selectionReasonCode` varchar(64),
	`capabilityUseKey` varchar(128) NOT NULL,
	`firstUsedAt` datetime(3) NOT NULL,
	CONSTRAINT `CapabilityUse_id` PRIMARY KEY(`id`),
	CONSTRAINT `CapabilityUse_invocation_capabilityUseKey_uq` UNIQUE(`invocationId`,`capabilityUseKey`)
);
--> statement-breakpoint
CREATE TABLE `CatalogEntry` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`resourceType` varchar(32) NOT NULL,
	`resourceId` varchar(36) NOT NULL,
	`displayName` varchar(256) NOT NULL,
	`description` text,
	`ownerUserId` varchar(36),
	`tagsJson` json,
	`lifecycleState` varchar(32) NOT NULL,
	`visibilitySummary` varchar(64) NOT NULL,
	`sourceUpdatedAt` datetime(3) NOT NULL,
	`projectedAt` datetime(3) NOT NULL,
	`catalogRevision` bigint NOT NULL,
	CONSTRAINT `CatalogEntry_id` PRIMARY KEY(`id`),
	CONSTRAINT `CatalogEntry_tenant_resourceType_resourceId_uq` UNIQUE(`tenantId`,`resourceType`,`resourceId`)
);
--> statement-breakpoint
CREATE TABLE `CatalogRevision` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`audience` enum('employee','runtime') NOT NULL,
	`currentRevision` bigint NOT NULL DEFAULT 0,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `CatalogRevision_id` PRIMARY KEY(`id`),
	CONSTRAINT `CatalogRevision_tenant_audience_uq` UNIQUE(`tenantId`,`audience`)
);
--> statement-breakpoint
CREATE TABLE `ContextCheckpoint` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`checkpointType` enum('assembly','compression','resume') NOT NULL,
	`sourceRangesJson` json NOT NULL,
	`sourceRangesHash` varchar(128) NOT NULL,
	`summaryRef` varchar(512),
	`summaryRedacted` text,
	`summaryHash` varchar(128) NOT NULL,
	`inputTokens` int NOT NULL,
	`retainedTokens` int NOT NULL,
	`compressedTokens` int NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`expiresAt` datetime(3) NOT NULL,
	CONSTRAINT `ContextCheckpoint_id` PRIMARY KEY(`id`),
	CONSTRAINT `ContextCheckpoint_tenant_invocation_type_ranges_uq` UNIQUE(`tenantId`,`invocationId`,`checkpointType`,`sourceRangesHash`)
);
--> statement-breakpoint
CREATE TABLE `Goal` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`objective` text NOT NULL,
	`successCriteriaJson` json NOT NULL,
	`constraintsJson` json,
	`currentStateJson` json,
	`goalState` enum('active','blocked','completed','cancelled') NOT NULL DEFAULT 'active',
	`createdBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`completedAt` datetime(3),
	CONSTRAINT `Goal_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `InvocationCommand` (
	`id` varchar(36) NOT NULL,
	`invocationId` varchar(36),
	`threadId` varchar(36) NOT NULL,
	`turnId` varchar(36),
	`commandType` enum('steer','interrupt','regenerate','resume','cancel') NOT NULL,
	`commandPayloadJson` json NOT NULL,
	`commandPayloadHash` varchar(128) NOT NULL,
	`commandState` enum('queued','dispatched','acknowledged','failed','cancelled') NOT NULL DEFAULT 'queued',
	`runtimeExecutionRef` varchar(256),
	`idempotencyKey` varchar(128),
	`errorCode` varchar(128),
	`errorMessage` text,
	`dispatchAttemptCount` int NOT NULL DEFAULT 0,
	`nextDispatchAt` datetime(3),
	`dispatchLeaseOwner` varchar(128),
	`dispatchLeaseExpiresAt` datetime(3),
	`lastDispatchAttemptAt` datetime(3),
	`lastTransientErrorCode` varchar(128),
	`createdAt` datetime(3) NOT NULL,
	`dispatchedAt` datetime(3),
	`acknowledgedAt` datetime(3),
	`failedAt` datetime(3),
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `InvocationCommand_id` PRIMARY KEY(`id`),
	CONSTRAINT `InvocationCommand_thread_idempotency_uq` UNIQUE(`threadId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `PendingInput` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`clientMessageId` varchar(128),
	`inputState` enum('pending','admitted','removed') NOT NULL DEFAULT 'pending',
	`queuePosition` decimal(20,10) NOT NULL,
	`inputJson` json NOT NULL,
	`inputHash` varchar(128) NOT NULL,
	`admittedTurnId` varchar(36),
	`admittedItemId` varchar(36),
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`removedAt` datetime(3),
	CONSTRAINT `PendingInput_id` PRIMARY KEY(`id`),
	CONSTRAINT `PendingInput_thread_client_message_uq` UNIQUE(`threadId`,`clientMessageId`)
);
--> statement-breakpoint
CREATE TABLE `ThreadEvent` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`eventSequence` bigint NOT NULL,
	`eventType` varchar(128) NOT NULL,
	`schemaVersion` int NOT NULL DEFAULT 1,
	`turnId` varchar(36),
	`itemId` varchar(36),
	`invocationId` varchar(36),
	`actorType` enum('user','agent','system','tool','service') NOT NULL,
	`actorId` varchar(36),
	`payloadJson` json NOT NULL,
	`correlationId` varchar(128),
	`causationId` varchar(128),
	`idempotencyKey` varchar(128),
	`occurredAt` datetime(3) NOT NULL,
	`ingestedAt` datetime(3) NOT NULL,
	CONSTRAINT `ThreadEvent_id` PRIMARY KEY(`id`),
	CONSTRAINT `ThreadEvent_thread_sequence_uq` UNIQUE(`threadId`,`eventSequence`),
	CONSTRAINT `ThreadEvent_thread_idempotency_uq` UNIQUE(`threadId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `ThreadItem` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`turnId` varchar(36) NOT NULL,
	`itemSequence` bigint NOT NULL,
	`itemType` enum('user_message','user_guidance','assistant_message','tool_call','artifact','job_result','child_thread','user_action') NOT NULL,
	`itemState` enum('pending','completed','failed','superseded','cancelled') NOT NULL DEFAULT 'pending',
	`authorType` enum('user','assistant','system','tool') NOT NULL,
	`authorId` varchar(36),
	`contentJson` json NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`contextPolicy` enum('include','summary_only','exclude','sensitive') NOT NULL DEFAULT 'include',
	`invocationId` varchar(36),
	`supersededByItemId` varchar(36),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `ThreadItem_id` PRIMARY KEY(`id`),
	CONSTRAINT `ThreadItem_thread_sequence_uq` UNIQUE(`threadId`,`itemSequence`)
);
--> statement-breakpoint
CREATE TABLE `ThreadRelation` (
	`id` varchar(36) NOT NULL,
	`parentThreadId` varchar(36) NOT NULL,
	`childThreadId` varchar(36) NOT NULL,
	`relationType` enum('delegate','fork','workflow_child') NOT NULL,
	`sourceTurnId` varchar(36),
	`sourceItemId` varchar(36),
	`sourceInvocationId` varchar(36),
	`targetAgentId` varchar(36),
	`taskPayloadRef` varchar(512),
	`taskPayloadHash` varchar(128),
	`contextTransferPolicyJson` json,
	`budgetPolicyJson` json,
	`budgetUsedJson` json,
	`relationState` enum('creating','active','cancel_requested','completed','failed','cancelled') NOT NULL DEFAULT 'creating',
	`itemId` varchar(36),
	`resultItemId` varchar(36),
	`resultRef` varchar(512),
	`resultHash` varchar(128),
	`createdAt` datetime(3) NOT NULL,
	`completedAt` datetime(3),
	CONSTRAINT `ThreadRelation_id` PRIMARY KEY(`id`),
	CONSTRAINT `ThreadRelation_parent_child_type_uq` UNIQUE(`parentThreadId`,`childThreadId`,`relationType`)
);
--> statement-breakpoint
CREATE TABLE `Thread` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`ownerUserId` varchar(36) NOT NULL,
	`defaultWorkspaceId` varchar(36),
	`activeGoalId` varchar(36),
	`title` text,
	`defaultModelRef` varchar(256),
	`defaultEnvironmentDefinitionId` varchar(36),
	`lifecycleState` enum('active','archived','deleted') NOT NULL DEFAULT 'active',
	`lastActivityAt` datetime(3) NOT NULL,
	`lastTurnSequence` bigint NOT NULL DEFAULT 0,
	`lastItemSequence` bigint NOT NULL DEFAULT 0,
	`lastEventSequence` bigint NOT NULL DEFAULT 0,
	`pendingQueueVersionNo` bigint NOT NULL DEFAULT 1,
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `Thread_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `Turn` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`turnSequence` bigint NOT NULL,
	`triggerType` enum('user_message','thread_schedule','thread_webhook','job_result_projection','system') NOT NULL,
	`triggerRef` varchar(256),
	`triggerItemId` varchar(36),
	`turnState` enum('accepted','queued','running','waiting_user','regenerating','completed','interrupted','failed','cancelled') NOT NULL DEFAULT 'accepted',
	`activeInvocationId` varchar(36),
	`latestInvocationId` varchar(36),
	`adoptedInvocationId` varchar(36),
	`finalItemId` varchar(36),
	`errorCode` varchar(128),
	`regenerationNo` bigint NOT NULL DEFAULT 0,
	`regenerationBaseState` enum('completed','interrupted','failed'),
	`acceptedAt` datetime(3) NOT NULL,
	`startedAt` datetime(3),
	`waitingAt` datetime(3),
	`finishedAt` datetime(3),
	`requestedAgentId` varchar(36),
	`agentSelectionMode` varchar(32),
	`versionNo` bigint NOT NULL DEFAULT 1,
	CONSTRAINT `Turn_id` PRIMARY KEY(`id`),
	CONSTRAINT `Turn_thread_sequence_uq` UNIQUE(`threadId`,`turnSequence`)
);
--> statement-breakpoint
CREATE TABLE `DeletionRequest` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`subjectType` enum('thread','memory_entry','artifact','user','retention_scope','user_data_export_scope') NOT NULL,
	`subjectId` varchar(128) NOT NULL,
	`deleteMode` enum('standard','privacy_request','retention_expiry') NOT NULL,
	`reasonCode` varchar(64) NOT NULL,
	`policyRevisionId` varchar(64),
	`requestedBy` varchar(128) NOT NULL,
	`requestPrincipalKind` enum('user','service') NOT NULL DEFAULT 'user',
	`requestState` enum('planning','blocked_by_hold','deleting','completed','partial','failed','cancelled') NOT NULL DEFAULT 'planning',
	`blockedReasonCodes` text,
	`auditEventId` varchar(36),
	`acceptedAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`completedAt` datetime(3),
	CONSTRAINT `DeletionRequest_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `DeletionStep` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`requestId` varchar(36) NOT NULL,
	`storeType` enum('mysql','object_storage','vector_search','trace_log','cache') NOT NULL,
	`subjectRef` varchar(256) NOT NULL,
	`stepState` enum('pending','running','completed','failed','blocked','retained','skipped') NOT NULL DEFAULT 'pending',
	`evidenceRef` varchar(256),
	`failureReason` text,
	`attemptCount` int NOT NULL DEFAULT 0,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`completedAt` datetime(3),
	CONSTRAINT `DeletionStep_id` PRIMARY KEY(`id`),
	CONSTRAINT `DeletionStep_request_store_subject_uq` UNIQUE(`requestId`,`storeType`,`subjectRef`)
);
--> statement-breakpoint
CREATE TABLE `DeploymentRouteSet` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`targetKind` enum('runtime','agent') NOT NULL,
	`targetIdentity` varchar(36) NOT NULL,
	`agentId` varchar(36),
	`routeScopeKey` varchar(128) NOT NULL,
	`routeScopeJson` json NOT NULL,
	`versionNo` bigint unsigned NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `DeploymentRouteSet_id` PRIMARY KEY(`id`),
	CONSTRAINT `DeploymentRouteSet_tenant_target_scope_uq` UNIQUE(`tenantId`,`targetKind`,`targetIdentity`,`routeScopeKey`),
	CONSTRAINT `DeploymentRouteSet_target_identity_check` CHECK (TRIM(`targetIdentity`) <> ''),
	CONSTRAINT `DeploymentRouteSet_target_consistency_check` CHECK ((`targetKind` = 'runtime' AND `targetIdentity` = 'runtime' AND `agentId` IS NULL) OR (`targetKind` = 'agent' AND `targetIdentity` = `agentId` AND `agentId` IS NOT NULL AND TRIM(`agentId`) <> ''))
);
--> statement-breakpoint
CREATE TABLE `DeploymentRoute` (
	`id` varchar(36) NOT NULL,
	`routeSetId` varchar(36) NOT NULL,
	`routeKey` varchar(128) NOT NULL,
	`agentRevisionId` varchar(36),
	`runtimeRevisionId` varchar(36),
	`trafficWeight` int NOT NULL,
	`priorityNo` int NOT NULL DEFAULT 0,
	`routeState` enum('enabled','disabled') NOT NULL DEFAULT 'enabled',
	`effectiveFrom` datetime(3),
	`effectiveUntil` datetime(3),
	`activeRouteRevisionId` varchar(36),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `DeploymentRoute_id` PRIMARY KEY(`id`),
	CONSTRAINT `DeploymentRoute_set_routeKey_uq` UNIQUE(`routeSetId`,`routeKey`),
	CONSTRAINT `DeploymentRoute_exact_one_target_check` CHECK (((`runtimeRevisionId` IS NOT NULL AND `agentRevisionId` IS NULL) OR (`runtimeRevisionId` IS NULL AND `agentRevisionId` IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE `Device` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`userId` varchar(36) NOT NULL,
	`deviceKey` varchar(128) NOT NULL,
	`publicKey` text NOT NULL,
	`deviceName` varchar(256) NOT NULL,
	`appVersion` varchar(32) NOT NULL,
	`deviceState` enum('active','revoked') NOT NULL DEFAULT 'active',
	`lastActiveAt` datetime(3) NOT NULL,
	`revokedAt` datetime,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `Device_id` PRIMARY KEY(`id`),
	CONSTRAINT `Device_tenant_key_uq` UNIQUE(`tenantId`,`deviceKey`)
);
--> statement-breakpoint
CREATE TABLE `EffectRecord` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`toolCallId` varchar(36) NOT NULL,
	`effectType` enum('create','update','delete','send','payment','deploy') NOT NULL,
	`targetSummaryJson` json NOT NULL,
	`effectState` enum('not_started','confirmed_success','confirmed_partial','confirmed_failure','unknown_effect') NOT NULL DEFAULT 'not_started',
	`externalIdempotencyKey` varchar(128),
	`externalResultRef` varchar(512),
	`verificationMethod` enum('provider_query','callback_evidence','manual_evidence'),
	`verifiedAt` datetime(3),
	`evidenceJson` json,
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `EffectRecord_id` PRIMARY KEY(`id`),
	CONSTRAINT `EffectRecord_toolCall_uq` UNIQUE(`toolCallId`)
);
--> statement-breakpoint
CREATE TABLE `EffectTarget` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`effectRecordId` varchar(36) NOT NULL,
	`targetRef` varchar(512) NOT NULL,
	`targetHash` varchar(128) NOT NULL,
	`targetState` enum('confirmed_success','confirmed_failure','unknown') NOT NULL DEFAULT 'unknown',
	`externalResultRef` varchar(512),
	`verifiedAt` datetime(3),
	`evidenceJson` json,
	`notes` text,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `EffectTarget_id` PRIMARY KEY(`id`),
	CONSTRAINT `EffectTarget_record_targetHash_uq` UNIQUE(`effectRecordId`,`targetHash`)
);
--> statement-breakpoint
CREATE TABLE `EnvironmentChangeRequest` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`invocationId` varchar(36),
	`fromEnvironmentDefinitionId` varchar(36) NOT NULL,
	`requestedEnvironmentDefinitionId` varchar(36) NOT NULL,
	`requestedDeviceId` varchar(36),
	`requestState` enum('pending','accepted_for_next_invocation','runtime_acknowledged','rejected','expired') NOT NULL DEFAULT 'pending',
	`reasonCode` varchar(128),
	`requestedBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`resolvedAt` datetime(3),
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `EnvironmentChangeRequest_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `EnvironmentDefinition` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`environmentKey` varchar(128) NOT NULL,
	`displayName` varchar(256) NOT NULL,
	`description` text,
	`environmentType` enum('desktop','cloud','remote','sandbox') NOT NULL,
	`filesystemPolicyJson` json NOT NULL,
	`networkPolicyJson` json NOT NULL,
	`resourceLimitsJson` json NOT NULL,
	`secretPolicyJson` json NOT NULL,
	`lifecycleState` enum('active','archived','deleted') NOT NULL DEFAULT 'active',
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime,
	CONSTRAINT `EnvironmentDefinition_id` PRIMARY KEY(`id`),
	CONSTRAINT `EnvironmentDefinition_tenant_key_uq` UNIQUE(`tenantId`,`environmentKey`)
);
--> statement-breakpoint
CREATE TABLE `EnvironmentLease` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`environmentDefinitionId` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`attemptId` varchar(36) NOT NULL,
	`deviceId` varchar(36),
	`workerRef` varchar(256),
	`leaseState` enum('allocated','active','releasing','released','expired','lost') NOT NULL DEFAULT 'allocated',
	`capabilitiesJson` json,
	`allocatedAt` datetime(3) NOT NULL,
	`lastHeartbeatAt` datetime(3),
	`releasedAt` datetime(3),
	`expiresAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `EnvironmentLease_id` PRIMARY KEY(`id`),
	CONSTRAINT `EnvironmentLease_invocation_attempt_uq` UNIQUE(`invocationId`,`attemptId`)
);
--> statement-breakpoint
CREATE TABLE `evaluation_case` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`run_id` varchar(36) NOT NULL,
	`case_key` varchar(128) NOT NULL,
	`scenario_ref` varchar(256),
	`input_redacted_json` json NOT NULL,
	`expected_json` json,
	`actual_redacted_json` json,
	`case_state` varchar(32) NOT NULL DEFAULT 'pending',
	`failure_reason` varchar(256),
	`evidence_json` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `evaluation_case_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `evaluation_result` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`run_id` varchar(36) NOT NULL,
	`case_id` varchar(36),
	`metric_key` varchar(64) NOT NULL,
	`metric_value` decimal(20,6) NOT NULL,
	`comparator` varchar(32) NOT NULL DEFAULT 'higher_better',
	`threshold_value` decimal(20,6),
	`passed` boolean NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `evaluation_result_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `evaluation_run` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`job_id` varchar(36),
	`agent_revision_id` varchar(36) NOT NULL,
	`runtime_revision_id` varchar(36),
	`route_id` varchar(36),
	`model_ref` varchar(128),
	`dataset_ref` varchar(256) NOT NULL,
	`strategy_key` varchar(64) NOT NULL,
	`run_state` varchar(32) NOT NULL DEFAULT 'queued',
	`threshold_config_json` json,
	`summary_json` json,
	`started_at` datetime(3),
	`finished_at` datetime(3),
	`created_by` varchar(36),
	`version_no` varchar(36) NOT NULL DEFAULT '1',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `evaluation_run_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `FileChange` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`toolCallId` varchar(36) NOT NULL,
	`workspaceBindingId` varchar(36) NOT NULL,
	`pathRef` varchar(512) NOT NULL,
	`changeType` enum('create','update','delete','rename','move') NOT NULL,
	`beforeHash` varchar(128),
	`afterHash` varchar(128),
	`artifactId` varchar(36),
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `FileChange_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `FilesystemCheckpoint` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`workspaceBindingId` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`checkpointType` varchar(32) NOT NULL,
	`checkpointRef` varchar(512) NOT NULL,
	`baseRevisionRef` varchar(512),
	`contentHash` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`expiresAt` datetime(3),
	CONSTRAINT `FilesystemCheckpoint_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `GovernanceConfigRevision` (
	`id` varchar(36) NOT NULL,
	`configSetId` varchar(36) NOT NULL,
	`revisionNo` bigint NOT NULL,
	`configJson` json NOT NULL,
	`configDigest` varchar(71) NOT NULL,
	`revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
	`createdBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`publishedAt` datetime(3),
	CONSTRAINT `GovernanceConfigRevision_id` PRIMARY KEY(`id`),
	CONSTRAINT `GovernanceConfigRevision_set_revisionNo_uq` UNIQUE(`configSetId`,`revisionNo`)
);
--> statement-breakpoint
CREATE TABLE `GovernanceConfigSet` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`configSetKey` varchar(128) NOT NULL,
	`ownerUserId` varchar(36),
	`currentRevisionId` varchar(36),
	`lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `GovernanceConfigSet_id` PRIMARY KEY(`id`),
	CONSTRAINT `GovernanceConfigSet_tenant_configSetKey_uq` UNIQUE(`tenantId`,`configSetKey`)
);
--> statement-breakpoint
CREATE TABLE `IdempotencyRecord` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`audience` enum('employee','runtime','gateway','admin') NOT NULL,
	`callerType` enum('user','device','workload','service') NOT NULL,
	`callerId` varchar(128) NOT NULL,
	`commandScope` varchar(128) NOT NULL,
	`idempotencyKey` varchar(256) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`processingState` enum('processing','completed','failed') NOT NULL DEFAULT 'processing',
	`httpStatus` int,
	`responseRef` varchar(128),
	`responseRedactedJson` text,
	`createdAt` datetime(3) NOT NULL,
	`completedAt` datetime(3),
	`expiresAt` datetime(3) NOT NULL,
	CONSTRAINT `IdempotencyRecord_id` PRIMARY KEY(`id`),
	CONSTRAINT `IdempotencyRecord_tenant_audience_caller_scope_key_uq` UNIQUE(`tenantId`,`audience`,`callerType`,`callerId`,`commandScope`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `PrincipalBinding` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`subjectType` enum('user','group','role','department') NOT NULL,
	`externalId` varchar(128) NOT NULL,
	`displayName` text,
	`userIdentityId` varchar(36),
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `PrincipalBinding_id` PRIMARY KEY(`id`),
	CONSTRAINT `PrincipalBinding_tenant_type_external_uq` UNIQUE(`tenantId`,`subjectType`,`externalId`)
);
--> statement-breakpoint
CREATE TABLE `Tenant` (
	`id` varchar(36) NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`status` enum('active','suspended') NOT NULL DEFAULT 'active',
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `Tenant_id` PRIMARY KEY(`id`),
	CONSTRAINT `Tenant_key_uq` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `UserIdentity` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`externalSubject` varchar(128) NOT NULL,
	`email` varchar(128) NOT NULL,
	`displayName` text,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `UserIdentity_id` PRIMARY KEY(`id`),
	CONSTRAINT `UserIdentity_tenant_subject_uq` UNIQUE(`tenantId`,`externalSubject`)
);
--> statement-breakpoint
CREATE TABLE `JobCommand` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`commandType` enum('cancel','retry') NOT NULL,
	`commandState` enum('queued','dispatched','acknowledged','rejected') NOT NULL DEFAULT 'queued',
	`idempotencyKey` varchar(128),
	`requestedBy` varchar(36),
	`reasonCode` varchar(128),
	`replacementJobId` varchar(36),
	`errorCode` varchar(128),
	`errorSummary` text,
	`commandPayloadJson` json,
	`createdAt` datetime(3) NOT NULL,
	`dispatchedAt` datetime(3),
	`acknowledgedAt` datetime(3),
	CONSTRAINT `JobCommand_id` PRIMARY KEY(`id`),
	CONSTRAINT `JobCommand_job_idempotency_uq` UNIQUE(`jobId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `JobEvent` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`eventSequence` bigint NOT NULL,
	`eventType` enum('job.queued','job.started','job.progress_updated','job.result_recorded','job.waiting','job.cancel_requested','job.retry_requested','job.completed','job.failed','job.cancelled','job.invocation_queued','job.invocation_started','job.invocation_waiting','job.invocation_resumed','job.invocation_completed','job.invocation_failed','job.invocation_cancelled','job.invocation_lost') NOT NULL,
	`schemaVersion` int NOT NULL DEFAULT 1,
	`invocationId` varchar(36),
	`actorType` enum('user','agent','system','tool','service') NOT NULL,
	`actorId` varchar(36),
	`payloadJson` json NOT NULL,
	`correlationId` varchar(128),
	`causationId` varchar(128),
	`idempotencyKey` varchar(128),
	`occurredAt` datetime(3) NOT NULL,
	`ingestedAt` datetime(3) NOT NULL,
	CONSTRAINT `JobEvent_id` PRIMARY KEY(`id`),
	CONSTRAINT `JobEvent_job_sequence_uq` UNIQUE(`jobId`,`eventSequence`),
	CONSTRAINT `JobEvent_job_idempotency_uq` UNIQUE(`jobId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `JobResultProjection` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`itemId` varchar(36) NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`sourceTurnId` varchar(36) NOT NULL,
	`projectionKind` enum('existing_source_turn','system_triggered_turn') NOT NULL,
	`resultRef` varchar(512) NOT NULL,
	`resultHash` varchar(128) NOT NULL,
	`resultSummaryJson` json,
	`createdBy` varchar(36),
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `JobResultProjection_id` PRIMARY KEY(`id`),
	CONSTRAINT `JobResultProjection_item_uq` UNIQUE(`itemId`)
);
--> statement-breakpoint
CREATE TABLE `Job` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`jobType` enum('scheduled','batch','deployment','evaluation','knowledge_build','system') NOT NULL,
	`triggerRef` varchar(256) NOT NULL,
	`jobState` enum('queued','running','waiting_external','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`replacesJobId` varchar(36),
	`threadId` varchar(36),
	`completionPolicyJson` json NOT NULL,
	`inputRef` varchar(512),
	`inputHash` varchar(128),
	`lastEventSequence` bigint NOT NULL DEFAULT 0,
	`resultRef` varchar(512),
	`resultHash` varchar(128),
	`errorCode` varchar(128),
	`errorSummary` text,
	`createdBy` varchar(36),
	`createdAt` datetime(3) NOT NULL,
	`startedAt` datetime(3),
	`finishedAt` datetime(3),
	`updatedAt` datetime(3) NOT NULL,
	`versionNo` bigint NOT NULL DEFAULT 1,
	CONSTRAINT `Job_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `KnowledgeBase` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`knowledgeKey` varchar(128) NOT NULL,
	`displayName` varchar(256) NOT NULL,
	`description` text,
	`ownerUserId` varchar(36),
	`indexState` enum('pending','indexing','ready','failed','stale') NOT NULL DEFAULT 'pending',
	`lifecycleState` enum('active','archived','deleted') NOT NULL DEFAULT 'active',
	`versionNo` varchar(64) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `KnowledgeBase_id` PRIMARY KEY(`id`),
	CONSTRAINT `KnowledgeBase_tenant_key_uq` UNIQUE(`tenantId`,`knowledgeKey`)
);
--> statement-breakpoint
CREATE TABLE `KnowledgeChunk` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`documentRevisionId` varchar(36) NOT NULL,
	`chunkNo` varchar(32) NOT NULL,
	`contentRef` varchar(512),
	`contentRedacted` text,
	`contentHash` varchar(128) NOT NULL,
	`metadataJson` json,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `KnowledgeChunk_id` PRIMARY KEY(`id`),
	CONSTRAINT `KnowledgeChunk_revision_chunk_uq` UNIQUE(`documentRevisionId`,`chunkNo`)
);
--> statement-breakpoint
CREATE TABLE `KnowledgeDocument` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`knowledgeBaseId` varchar(36) NOT NULL,
	`documentKey` varchar(128) NOT NULL,
	`title` varchar(512) NOT NULL,
	`sourceType` enum('upload','external_url','manual','synced','generated') NOT NULL,
	`sourceRef` varchar(512),
	`currentRevisionId` varchar(36),
	`lifecycleState` enum('active','archived','deleted') NOT NULL DEFAULT 'active',
	`versionNo` varchar(64) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `KnowledgeDocument_id` PRIMARY KEY(`id`),
	CONSTRAINT `KnowledgeDocument_base_key_uq` UNIQUE(`knowledgeBaseId`,`documentKey`)
);
--> statement-breakpoint
CREATE TABLE `KnowledgeDocumentRevision` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`documentId` varchar(36) NOT NULL,
	`revisionNo` varchar(32) NOT NULL,
	`contentRef` varchar(512),
	`contentRedacted` text,
	`contentHash` varchar(128) NOT NULL,
	`aclSnapshotHash` varchar(128),
	`aclSnapshotJson` json,
	`indexState` enum('pending','indexing','ready','failed','stale') NOT NULL DEFAULT 'pending',
	`revisionState` enum('draft','published','superseded','retracted') NOT NULL DEFAULT 'draft',
	`createdBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`publishedAt` datetime(3),
	CONSTRAINT `KnowledgeDocumentRevision_id` PRIMARY KEY(`id`),
	CONSTRAINT `KnowledgeDocumentRevision_doc_rev_uq` UNIQUE(`documentId`,`revisionNo`)
);
--> statement-breakpoint
CREATE TABLE `KnowledgeIndex` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`chunkId` varchar(36) NOT NULL,
	`indexProvider` varchar(64) NOT NULL,
	`indexRef` varchar(512) NOT NULL,
	`embeddingModelRef` varchar(128),
	`contentHash` varchar(128) NOT NULL,
	`indexedAt` datetime(3) NOT NULL,
	CONSTRAINT `KnowledgeIndex_id` PRIMARY KEY(`id`),
	CONSTRAINT `KnowledgeIndex_chunk_provider_uq` UNIQUE(`chunkId`,`indexProvider`)
);
--> statement-breakpoint
CREATE TABLE `MemoryCandidate` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`sourceThreadId` varchar(36),
	`sourceTurnId` varchar(36),
	`sourceItemId` varchar(36),
	`sourceJobId` varchar(36),
	`sourceArtifactId` varchar(36),
	`sourceHash` varchar(128) NOT NULL,
	`proposedScopeType` enum('thread','workspace','agent','user_preference','organization') NOT NULL,
	`proposedScopeRef` varchar(128),
	`memoryType` varchar(64) NOT NULL,
	`rationaleCode` varchar(64) NOT NULL,
	`contentRef` varchar(512),
	`contentRedacted` text,
	`contentHash` varchar(128) NOT NULL,
	`candidateKey` varchar(128) NOT NULL,
	`sensitivityClass` enum('public','internal','confidential','restricted') NOT NULL,
	`candidateState` enum('submitted','accepted','rejected','needs_review','expired') NOT NULL,
	`decisionReasonCodesJson` json,
	`resolvedMemoryEntryId` varchar(36),
	`requestedExpiresAt` datetime(3),
	`proposedAt` datetime(3) NOT NULL,
	`resolvedAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `MemoryCandidate_id` PRIMARY KEY(`id`),
	CONSTRAINT `MemoryCandidate_candidateKey_uq` UNIQUE(`candidateKey`),
	CONSTRAINT `MemoryCandidate_exactly_one_source_ck` CHECK(((`MemoryCandidate`.`sourceItemId` IS NOT NULL) + (`MemoryCandidate`.`sourceJobId` IS NOT NULL) + (`MemoryCandidate`.`sourceArtifactId` IS NOT NULL)) = 1),
	CONSTRAINT `MemoryCandidate_accepted_entry_ck` CHECK((`MemoryCandidate`.`candidateState` <> 'accepted' OR `MemoryCandidate`.`resolvedMemoryEntryId` IS NOT NULL)),
	CONSTRAINT `MemoryCandidate_rejected_entry_ck` CHECK((`MemoryCandidate`.`candidateState` NOT IN ('rejected','expired') OR `MemoryCandidate`.`resolvedMemoryEntryId` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `MemoryEntry` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`entryKey` varchar(128) NOT NULL,
	`scopeType` enum('thread','workspace','agent','user_preference','organization') NOT NULL,
	`scopeRef` varchar(128),
	`memoryType` varchar(64) NOT NULL,
	`contentRef` varchar(512),
	`contentRedacted` text,
	`contentHash` varchar(128) NOT NULL,
	`sensitivityClass` enum('public','internal','confidential','restricted') NOT NULL,
	`memoryState` enum('active','archived','superseded') NOT NULL DEFAULT 'active',
	`validFrom` datetime(3) NOT NULL,
	`expiresAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `MemoryEntry_id` PRIMARY KEY(`id`),
	CONSTRAINT `MemoryEntry_entryKey_uq` UNIQUE(`entryKey`)
);
--> statement-breakpoint
CREATE TABLE `MemoryIndex` (
	`id` varchar(36) NOT NULL,
	`memoryEntryId` varchar(36) NOT NULL,
	`indexProvider` varchar(64) NOT NULL,
	`indexRef` varchar(512) NOT NULL,
	`embeddingModelRef` varchar(128),
	`contentHash` varchar(128) NOT NULL,
	`indexedAt` datetime(3) NOT NULL,
	CONSTRAINT `MemoryIndex_id` PRIMARY KEY(`id`),
	CONSTRAINT `MemoryIndex_entry_provider_uq` UNIQUE(`memoryEntryId`,`indexProvider`)
);
--> statement-breakpoint
CREATE TABLE `MemorySource` (
	`id` varchar(36) NOT NULL,
	`memoryEntryId` varchar(36) NOT NULL,
	`memoryCandidateId` varchar(36),
	`sourceType` enum('thread_item','job','artifact') NOT NULL,
	`sourceId` varchar(128) NOT NULL,
	`sourceHash` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `MemorySource_id` PRIMARY KEY(`id`),
	CONSTRAINT `MemorySource_entry_type_id_hash_uq` UNIQUE(`memoryEntryId`,`sourceType`,`sourceId`,`sourceHash`)
);
--> statement-breakpoint
CREATE TABLE `Grant` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`userId` varchar(36) NOT NULL,
	`grantType` enum('user_consent','policy','admin_override') NOT NULL,
	`scopeJson` json NOT NULL,
	`credentialRefId` varchar(36) NOT NULL,
	`issuedBy` varchar(128) NOT NULL,
	`issuedAt` datetime(3) NOT NULL,
	`expiresAt` datetime(3),
	`revokedAt` datetime(3),
	`revokeReasonCode` varchar(64),
	`grantState` enum('active','revoked','expired') NOT NULL DEFAULT 'active',
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `Grant_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `PermissionDecision` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`toolCallId` varchar(36) NOT NULL,
	`decisionSequence` int NOT NULL,
	`decision` enum('allow','pause','block') NOT NULL,
	`policyRevisionId` varchar(36) NOT NULL,
	`reasonCodesJson` json NOT NULL,
	`riskSummaryJson` json,
	`decisionSummary` text,
	`decidedBy` varchar(128) NOT NULL,
	`decidedAt` datetime(3) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `PermissionDecision_id` PRIMARY KEY(`id`),
	CONSTRAINT `PermissionDecision_toolCall_sequence_uq` UNIQUE(`toolCallId`,`decisionSequence`)
);
--> statement-breakpoint
CREATE TABLE `PolicyRevision` (
	`id` varchar(36) NOT NULL,
	`policySetId` varchar(36) NOT NULL,
	`revisionNo` bigint NOT NULL,
	`defaultDecision` enum('allow','pause','block') NOT NULL,
	`rulesHash` varchar(128) NOT NULL,
	`revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
	`createdBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`publishedAt` datetime(3),
	CONSTRAINT `PolicyRevision_id` PRIMARY KEY(`id`),
	CONSTRAINT `PolicyRevision_set_revisionNo_uq` UNIQUE(`policySetId`,`revisionNo`)
);
--> statement-breakpoint
CREATE TABLE `PolicySet` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`policySetKey` varchar(128) NOT NULL,
	`ownerUserId` varchar(36),
	`currentRevisionId` varchar(36),
	`lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `PolicySet_id` PRIMARY KEY(`id`),
	CONSTRAINT `PolicySet_tenant_policySetKey_uq` UNIQUE(`tenantId`,`policySetKey`)
);
--> statement-breakpoint
CREATE TABLE `Policy` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`policySetId` varchar(36) NOT NULL,
	`policyRevisionId` varchar(36) NOT NULL,
	`ruleKey` varchar(128) NOT NULL,
	`toolPattern` varchar(128) NOT NULL,
	`argMatcherJson` json,
	`decision` enum('allow','pause','block') NOT NULL,
	`scopeJson` json NOT NULL,
	`reason` varchar(256),
	`priority` int NOT NULL DEFAULT 0,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `Policy_id` PRIMARY KEY(`id`),
	CONSTRAINT `Policy_revision_ruleKey_uq` UNIQUE(`policyRevisionId`,`ruleKey`)
);
--> statement-breakpoint
CREATE TABLE `EventDeliveryFailure` (
	`id` varchar(36) NOT NULL,
	`consumerName` varchar(128) NOT NULL,
	`streamType` enum('thread_event','job_event') NOT NULL,
	`streamId` varchar(36) NOT NULL,
	`eventId` varchar(36) NOT NULL,
	`eventSequence` bigint NOT NULL,
	`payloadHash` varchar(128),
	`failureClass` varchar(64) NOT NULL,
	`failureState` enum('retrying','quarantined','resolved') NOT NULL DEFAULT 'retrying',
	`attemptCount` int NOT NULL DEFAULT 0,
	`nextRetryAt` datetime(3),
	`lastErrorCode` varchar(128),
	`lastErrorDetailJson` json,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`resolvedAt` datetime(3),
	CONSTRAINT `EventDeliveryFailure_id` PRIMARY KEY(`id`),
	CONSTRAINT `EventDeliveryFailure_consumer_stream_event_uq` UNIQUE(`consumerName`,`streamType`,`streamId`,`eventId`)
);
--> statement-breakpoint
CREATE TABLE `EventStreamFloor` (
	`streamType` enum('thread_event','job_event') NOT NULL,
	`streamId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`earliestAvailableSequence` bigint NOT NULL DEFAULT 1,
	`latestSequence` bigint NOT NULL DEFAULT 0,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `EventStreamFloor_stream_type_stream_id_uq` UNIQUE(`streamType`,`streamId`)
);
--> statement-breakpoint
CREATE TABLE `ProjectionCheckpoint` (
	`consumerName` varchar(128) NOT NULL,
	`streamType` enum('thread_event','job_event') NOT NULL,
	`shardKey` varchar(36) NOT NULL,
	`lastSequence` bigint NOT NULL DEFAULT 0,
	`lastEventId` varchar(36),
	`updatedAt` datetime(3) NOT NULL,
	`versionNo` bigint NOT NULL DEFAULT 1,
	CONSTRAINT `ProjectionCheckpoint_consumer_stream_shard_uq` UNIQUE(`consumerName`,`streamType`,`shardKey`)
);
--> statement-breakpoint
CREATE TABLE `ThreadListProjection` (
	`threadId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`ownerUserId` varchar(36) NOT NULL,
	`title` text,
	`lifecycleState` varchar(32) NOT NULL DEFAULT 'active',
	`lastActivityAt` datetime(3) NOT NULL,
	`lastItemSummary` text,
	`lastItemType` varchar(32),
	`lastItemSequence` bigint,
	`lastItemAuthorType` varchar(32),
	`lastItemCreatedAt` datetime(3),
	`currentTurnId` varchar(36),
	`currentTurnSequence` bigint,
	`currentTurnState` varchar(32),
	`latestEventSequence` bigint NOT NULL DEFAULT 0,
	`latestEventId` varchar(36),
	`hasUnreadEvents` int NOT NULL DEFAULT 0,
	`updatedAt` datetime(3) NOT NULL,
	`versionNo` bigint NOT NULL DEFAULT 1,
	CONSTRAINT `ThreadListProjection_threadId` PRIMARY KEY(`threadId`)
);
--> statement-breakpoint
CREATE TABLE `TurnTimelineProjection` (
	`turnId` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`turnSequence` bigint NOT NULL,
	`turnState` varchar(32) NOT NULL DEFAULT 'accepted',
	`triggerType` varchar(32) NOT NULL,
	`triggerItemId` varchar(36),
	`triggerItemType` varchar(32),
	`triggerItemSummary` text,
	`triggerItemCreatedAt` datetime(3),
	`finalItemId` varchar(36),
	`finalItemType` varchar(32),
	`finalItemSummary` text,
	`finalItemCreatedAt` datetime(3),
	`itemCount` int NOT NULL DEFAULT 0,
	`lastItemSummary` text,
	`lastItemType` varchar(32),
	`lastItemSequence` bigint,
	`lastItemCreatedAt` datetime(3),
	`acceptedAt` datetime(3) NOT NULL,
	`startedAt` datetime(3),
	`waitingAt` datetime(3),
	`finishedAt` datetime(3),
	`errorCode` varchar(128),
	`regenerationNo` bigint NOT NULL DEFAULT 0,
	`latestEventSequence` bigint NOT NULL DEFAULT 0,
	`updatedAt` datetime(3) NOT NULL,
	`versionNo` bigint NOT NULL DEFAULT 1,
	CONSTRAINT `TurnTimelineProjection_turnId` PRIMARY KEY(`turnId`),
	CONSTRAINT `TurnTimelineProjection_thread_sequence_uq` UNIQUE(`threadId`,`turnSequence`)
);
--> statement-breakpoint
CREATE TABLE `RecoveryDrillCheck` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`drillId` varchar(36) NOT NULL,
	`checkType` enum('event_sequence','projection_checkpoint','artifact_ref','legal_hold','deletion_evidence','tool_call_pending','unknown_effect','job_recovery','user_action_wait') NOT NULL,
	`checkState` enum('pending','running','passed','failed','skipped') NOT NULL DEFAULT 'pending',
	`evidenceRef` varchar(256),
	`detailsJson` text,
	`failureReason` text,
	`durationMs` int,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`completedAt` datetime(3),
	CONSTRAINT `RecoveryDrillCheck_id` PRIMARY KEY(`id`),
	CONSTRAINT `RecoveryDrillCheck_drill_check_uq` UNIQUE(`drillId`,`checkType`)
);
--> statement-breakpoint
CREATE TABLE `RecoveryDrill` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`drillType` enum('db_restore','object_version','secret_restore','runtime_failover','queue_failover') NOT NULL,
	`drillState` enum('scheduled','running','completed','failed','cancelled') NOT NULL DEFAULT 'scheduled',
	`rpoTargetSeconds` int NOT NULL,
	`rtoTargetSeconds` int NOT NULL,
	`rpoActualSeconds` int,
	`rtoActualSeconds` int,
	`environmentTag` varchar(128) NOT NULL,
	`reason` text,
	`executedBy` varchar(128) NOT NULL,
	`executedByKind` enum('user','service') NOT NULL DEFAULT 'user',
	`consistencySummaryJson` text,
	`auditEventId` varchar(36),
	`failureReason` text,
	`requestId` varchar(64),
	`scheduledAt` datetime(3) NOT NULL,
	`startedAt` datetime(3),
	`completedAt` datetime(3),
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `RecoveryDrill_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `LegalHold` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`targetType` enum('tenant','thread','invocation','job','artifact','agent_revision') NOT NULL,
	`targetId` varchar(128) NOT NULL,
	`holdState` enum('active','released') NOT NULL DEFAULT 'active',
	`reason` text NOT NULL,
	`createdBy` varchar(128) NOT NULL,
	`approvedBy` varchar(128) NOT NULL,
	`validUntil` datetime(3) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`releasedAt` datetime(3),
	`releasedBy` varchar(128),
	`releaseReason` text,
	CONSTRAINT `LegalHold_id` PRIMARY KEY(`id`),
	CONSTRAINT `LegalHold_tenant_target_uq` UNIQUE(`tenantId`,`targetType`,`targetId`)
);
--> statement-breakpoint
CREATE TABLE `RetentionPolicy` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`objectType` enum('thread','event','trace','audit','artifact','memory','knowledge','job','security_log') NOT NULL,
	`retentionDays` varchar(16) NOT NULL,
	`legalHoldDays` varchar(16),
	`dataClass` varchar(64) NOT NULL,
	`statutoryRequirements` text NOT NULL,
	`description` text NOT NULL,
	`createdBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedBy` varchar(128) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `RetentionPolicy_id` PRIMARY KEY(`id`),
	CONSTRAINT `RetentionPolicy_tenant_object_uq` UNIQUE(`tenantId`,`objectType`)
);
--> statement-breakpoint
CREATE TABLE `RuntimeRevision` (
	`id` varchar(36) NOT NULL,
	`runtimeId` varchar(36) NOT NULL,
	`revisionNo` bigint NOT NULL,
	`protocolType` varchar(32) NOT NULL,
	`protocolContractRevision` varchar(128) NOT NULL,
	`runtimeEvidenceKind` enum('hosted_artifact','external_endpoint') NOT NULL,
	`runtimeTargetDigest` varchar(71) NOT NULL,
	`endpointRef` varchar(512) NOT NULL,
	`runtimeArtifactRef` varchar(512),
	`artifactId` varchar(36),
	`artifactDigest` varchar(71),
	`runtimeCapabilitiesJson` json NOT NULL,
	`identityMode` varchar(32) NOT NULL,
	`networkZone` varchar(32) NOT NULL,
	`configHash` varchar(128) NOT NULL,
	`credentialRefId` varchar(36),
	`revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
	`createdBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`publishedAt` datetime(3),
	CONSTRAINT `RuntimeRevision_id` PRIMARY KEY(`id`),
	CONSTRAINT `RuntimeRevision_runtime_revisionNo_uq` UNIQUE(`runtimeId`,`revisionNo`)
);
--> statement-breakpoint
CREATE TABLE `Runtime` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`runtimeKey` varchar(128) NOT NULL,
	`displayName` varchar(256) NOT NULL,
	`runtimeKind` enum('hosted','external') NOT NULL,
	`ownerUserId` varchar(36) NOT NULL,
	`lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
	`currentRevisionId` varchar(36),
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime,
	CONSTRAINT `Runtime_id` PRIMARY KEY(`id`),
	CONSTRAINT `Runtime_tenant_runtimeKey_uq` UNIQUE(`tenantId`,`runtimeKey`)
);
--> statement-breakpoint
CREATE TABLE `ExecutionBinding` (
	`invocationId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`runtimeRevisionId` varchar(36) NOT NULL,
	`deploymentRouteId` varchar(36) NOT NULL,
	`modelProvider` varchar(128) NOT NULL,
	`modelId` varchar(256) NOT NULL,
	`modelRevisionRef` varchar(256),
	`initialEnvironmentLeaseId` varchar(36),
	`workspaceBindingId` varchar(36),
	`policyRevisionId` varchar(36) NOT NULL,
	`policyRulesDigest` varchar(71) NOT NULL,
	`governanceConfigRevisionId` varchar(36) NOT NULL,
	`governanceConfigDigest` varchar(71) NOT NULL,
	`contextCheckpointId` varchar(36),
	`routeRevisionId` varchar(36) NOT NULL,
	`routeActivationId` varchar(36) NOT NULL,
	`routeContentDigest` varchar(71) NOT NULL,
	`runtimeArtifactId` varchar(36),
	`runtimeArtifactDigest` varchar(71),
	`runtimeEvidenceKind` enum('hosted_artifact','external_endpoint') NOT NULL,
	`runtimeConfigDigest` varchar(71) NOT NULL,
	`runtimeTargetDigest` varchar(71) NOT NULL,
	`capabilityManifestDigest` varchar(71) NOT NULL,
	`runtimeAttestationIds` json NOT NULL,
	`runtimePublicationRecordId` varchar(36) NOT NULL,
	`conformanceRunId` varchar(36) NOT NULL,
	`resolutionInputDigest` varchar(71) NOT NULL,
	`projectionVersionNo` int NOT NULL,
	`environmentDefinitionRevisionId` varchar(36),
	`configHash` varchar(128) NOT NULL,
	`boundAt` datetime(3) NOT NULL,
	CONSTRAINT `ExecutionBinding_invocationId` PRIMARY KEY(`invocationId`),
	CONSTRAINT `ExecutionBinding_runtimeAttestationIds_non_empty` CHECK(JSON_TYPE(`ExecutionBinding`.`runtimeAttestationIds`) = 'ARRAY' AND (JSON_LENGTH(`ExecutionBinding`.`runtimeAttestationIds`) >= 1 OR `ExecutionBinding`.`runtimeEvidenceKind` = 'external_endpoint'))
);
--> statement-breakpoint
CREATE TABLE `ExecutionOwnership` (
	`id` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`deviceId` varchar(36),
	`environmentLeaseId` varchar(36),
	`ownershipState` enum('active','released','lost') NOT NULL DEFAULT 'active',
	`leaseEpoch` bigint NOT NULL,
	`acquiredAt` datetime(3) NOT NULL,
	`lastHeartbeatAt` datetime(3),
	`releasedAt` datetime(3),
	CONSTRAINT `ExecutionOwnership_id` PRIMARY KEY(`id`),
	CONSTRAINT `ExecutionOwnership_invocation_epoch_uq` UNIQUE(`invocationId`,`leaseEpoch`)
);
--> statement-breakpoint
CREATE TABLE `InvocationAttempt` (
	`id` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`attemptNo` int NOT NULL,
	`attemptState` enum('queued','running','completed','failed','cancelled','lost') NOT NULL DEFAULT 'queued',
	`environmentLeaseId` varchar(36),
	`workerRef` varchar(256),
	`runtimeExecutionRef` varchar(256),
	`checkpointRef` varchar(512),
	`retryReasonCode` varchar(64),
	`startedAt` datetime(3),
	`finishedAt` datetime(3),
	`lastHeartbeatAt` datetime(3),
	`errorCode` varchar(128),
	`errorSummary` text,
	`dispatchAttemptCount` int NOT NULL DEFAULT 0,
	`nextDispatchAt` datetime(3),
	`dispatchLeaseOwner` varchar(128),
	`dispatchLeaseExpiresAt` datetime(3),
	`lastDispatchAttemptAt` datetime(3),
	`lastTransientErrorCode` varchar(128),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `InvocationAttempt_id` PRIMARY KEY(`id`),
	CONSTRAINT `InvocationAttempt_invocation_attempt_uq` UNIQUE(`invocationId`,`attemptNo`)
);
--> statement-breakpoint
CREATE TABLE `Invocation` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`threadId` varchar(36),
	`turnId` varchar(36),
	`jobId` varchar(36),
	`invocationSequence` bigint NOT NULL,
	`invocationKind` enum('initial','regenerate','job') NOT NULL,
	`executionState` enum('queued','running','waiting_user','completed','failed','cancelled','lost') NOT NULL DEFAULT 'queued',
	`triggerItemId` varchar(36),
	`replacesInvocationId` varchar(36),
	`outputItemId` varchar(36),
	`resultRef` varchar(512),
	`runtimeSessionBindingId` varchar(36),
	`runtimeExecutionRef` varchar(256),
	`startedAt` datetime(3),
	`finishedAt` datetime(3),
	`lastHeartbeatAt` datetime(3),
	`errorCode` varchar(128),
	`errorSummary` text,
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `Invocation_id` PRIMARY KEY(`id`),
	CONSTRAINT `Invocation_thread_sequence_uq` UNIQUE(`threadId`,`invocationSequence`),
	CONSTRAINT `Invocation_job_sequence_uq` UNIQUE(`jobId`,`invocationSequence`)
);
--> statement-breakpoint
CREATE TABLE `RuntimeEventIngress` (
	`id` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`producerEventId` varchar(128) NOT NULL,
	`producerSequence` bigint NOT NULL,
	`candidateType` varchar(64) NOT NULL,
	`schemaVersion` int NOT NULL DEFAULT 1,
	`payloadHash` varchar(128) NOT NULL,
	`payloadJson` json,
	`ingressState` enum('accepted','mapped','rejected') NOT NULL DEFAULT 'accepted',
	`mappedItemId` varchar(36),
	`mappedThreadEventId` varchar(36),
	`mappedJobEventId` varchar(36),
	`receivedAt` datetime(3) NOT NULL,
	`mappedAt` datetime(3),
	`rejectedReason` varchar(256),
	CONSTRAINT `RuntimeEventIngress_id` PRIMARY KEY(`id`),
	CONSTRAINT `RuntimeEventIngress_invocation_producer_event_uq` UNIQUE(`invocationId`,`producerEventId`),
	CONSTRAINT `RuntimeEventIngress_invocation_producer_seq_uq` UNIQUE(`invocationId`,`producerSequence`)
);
--> statement-breakpoint
CREATE TABLE `RuntimeSessionBinding` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`runtimeRevisionId` varchar(36) NOT NULL,
	`threadId` varchar(36),
	`jobId` varchar(36),
	`externalSessionRef` varchar(256) NOT NULL,
	`bindingState` enum('active','closed','lost') NOT NULL DEFAULT 'active',
	`createdAt` datetime(3) NOT NULL,
	`lastUsedAt` datetime(3) NOT NULL,
	`closedAt` datetime(3),
	CONSTRAINT `RuntimeSessionBinding_id` PRIMARY KEY(`id`),
	CONSTRAINT `RuntimeSessionBinding_runtime_external_ref_uq` UNIQUE(`runtimeRevisionId`,`externalSessionRef`)
);
--> statement-breakpoint
CREATE TABLE `IncidentContainment` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`incidentId` varchar(36) NOT NULL,
	`actionType` enum('revoke_credential','disable_tool_provider','disable_tool','disable_route','withdraw_agent_revision','withdraw_runtime_revision','revoke_workload_token','isolate_environment','quarantine_event') NOT NULL,
	`actionState` enum('pending','applied','failed','reverted') NOT NULL DEFAULT 'pending',
	`evidenceRef` varchar(256),
	`targetRef` varchar(256),
	`detailsJson` text,
	`failureReason` text,
	`appliedAt` datetime(3),
	`revertedAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `IncidentContainment_id` PRIMARY KEY(`id`),
	CONSTRAINT `IncidentContainment_incident_action_uq` UNIQUE(`incidentId`,`actionType`)
);
--> statement-breakpoint
CREATE TABLE `SecurityIncident` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`incidentKey` varchar(128) NOT NULL,
	`severity` enum('low','medium','high','critical') NOT NULL,
	`incidentState` enum('open','investigating','contained','resolved','escalated') NOT NULL DEFAULT 'open',
	`targetType` enum('agent','agent_revision','tool_provider','tool','credential','runtime','environment','workload_token','other') NOT NULL,
	`targetId` varchar(128) NOT NULL,
	`summary` text,
	`detectedBy` varchar(64) NOT NULL,
	`detectedAt` datetime(3) NOT NULL,
	`investigatingAt` datetime(3),
	`containedAt` datetime(3),
	`resolvedAt` datetime(3),
	`closedBy` varchar(128),
	`closureReason` text,
	`containmentSummaryJson` text,
	`auditEventId` varchar(36),
	`requestId` varchar(64),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `SecurityIncident_id` PRIMARY KEY(`id`),
	CONSTRAINT `SecurityIncident_tenant_key_uq` UNIQUE(`tenantId`,`incidentKey`)
);
--> statement-breakpoint
CREATE TABLE `Skill` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`skillKey` varchar(128) NOT NULL,
	`displayName` varchar(256) NOT NULL,
	`description` text,
	`ownerUserId` varchar(36) NOT NULL,
	`lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
	`currentVersionId` varchar(36),
	`visibilityScope` varchar(32) NOT NULL DEFAULT 'tenant',
	`sourceType` varchar(32) NOT NULL DEFAULT 'local',
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `Skill_id` PRIMARY KEY(`id`),
	CONSTRAINT `Skill_tenant_skillKey_uq` UNIQUE(`tenantId`,`skillKey`)
);
--> statement-breakpoint
CREATE TABLE `SkillVersion` (
	`id` varchar(36) NOT NULL,
	`skillId` varchar(36) NOT NULL,
	`versionNo` bigint NOT NULL,
	`contentRef` varchar(512) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`manifestJson` json,
	`revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
	`sourceType` varchar(32) NOT NULL DEFAULT 'local',
	`sourceRef` varchar(256),
	`createdBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`publishedAt` datetime(3),
	CONSTRAINT `SkillVersion_id` PRIMARY KEY(`id`),
	CONSTRAINT `SkillVersion_skill_versionNo_uq` UNIQUE(`skillId`,`versionNo`)
);
--> statement-breakpoint
CREATE TABLE `SkillSyncBinding` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`remoteAssetId` varchar(256) NOT NULL,
	`remoteName` varchar(128) NOT NULL,
	`remoteDisplayName` varchar(256),
	`remoteVersion` varchar(128) NOT NULL,
	`remoteVersionId` varchar(256),
	`remoteContentHash` varchar(256),
	`localSkillId` varchar(36) NOT NULL,
	`localSkillVersionId` varchar(36),
	`localName` varchar(128) NOT NULL,
	`syncState` varchar(32) NOT NULL DEFAULT 'active',
	`lastSyncedAt` datetime(3),
	`lastCheckedAt` datetime(3),
	`lastError` text,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `SkillSyncBinding_id` PRIMARY KEY(`id`),
	CONSTRAINT `SkillSyncBinding_tenant_remoteAssetId_uq` UNIQUE(`tenantId`,`remoteAssetId`)
);
--> statement-breakpoint
CREATE TABLE `CapabilityReview` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`resourceType` enum('skill','tool') NOT NULL,
	`resourceId` varchar(36) NOT NULL,
	`oldRevisionId` varchar(36),
	`newRevisionId` varchar(36) NOT NULL,
	`diffType` varchar(64) NOT NULL,
	`requiresReview` boolean NOT NULL DEFAULT false,
	`description` text NOT NULL,
	`affectedAgentsJson` json NOT NULL,
	`reviewState` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`reviewedBy` varchar(128),
	`reviewedAt` datetime(3),
	`reviewNotes` text,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `CapabilityReview_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ToolCall` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`threadId` varchar(36),
	`turnId` varchar(36),
	`jobId` varchar(36),
	`callSequence` bigint NOT NULL,
	`toolId` varchar(36) NOT NULL,
	`toolSchemaRevisionId` varchar(36) NOT NULL,
	`schemaHash` varchar(128) NOT NULL,
	`callState` varchar(32) NOT NULL DEFAULT 'proposed',
	`operationId` varchar(128) NOT NULL,
	`argumentsRedactedJson` json NOT NULL,
	`argumentsHash` varchar(128) NOT NULL,
	`environmentLeaseId` varchar(36),
	`resultSummaryJson` json,
	`resultArtifactId` varchar(36),
	`itemId` varchar(36),
	`errorCode` varchar(128),
	`errorSummary` text,
	`startedAt` datetime(3),
	`finishedAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `ToolCall_id` PRIMARY KEY(`id`),
	CONSTRAINT `ToolCall_invocation_callSequence_uq` UNIQUE(`invocationId`,`callSequence`),
	CONSTRAINT `ToolCall_tool_operationId_uq` UNIQUE(`toolId`,`operationId`)
);
--> statement-breakpoint
CREATE TABLE `Connection` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`connectionKey` varchar(128) NOT NULL,
	`connectionType` varchar(32) NOT NULL,
	`endpointRef` varchar(512),
	`authMethod` varchar(32) NOT NULL DEFAULT 'none',
	`ownerUserId` varchar(36) NOT NULL,
	`lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `Connection_id` PRIMARY KEY(`id`),
	CONSTRAINT `Connection_tenant_connectionKey_uq` UNIQUE(`tenantId`,`connectionKey`)
);
--> statement-breakpoint
CREATE TABLE `CredentialRef` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`connectionId` varchar(36),
	`provider` varchar(64) NOT NULL,
	`vaultRef` varchar(512) NOT NULL,
	`fingerprint` varchar(128) NOT NULL,
	`scopeJson` json,
	`expiresAt` datetime(3),
	`lifecycleState` enum('active','rotated','revoked') NOT NULL DEFAULT 'active',
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `CredentialRef_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ToolProvider` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`providerKey` varchar(128) NOT NULL,
	`providerType` varchar(32) NOT NULL,
	`connectionId` varchar(36),
	`trustLevel` varchar(32) NOT NULL DEFAULT 'standard',
	`displayName` varchar(256) NOT NULL,
	`description` text,
	`ownerUserId` varchar(36) NOT NULL,
	`lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `ToolProvider_id` PRIMARY KEY(`id`),
	CONSTRAINT `ToolProvider_tenant_providerKey_uq` UNIQUE(`tenantId`,`providerKey`)
);
--> statement-breakpoint
CREATE TABLE `ToolSchemaRevision` (
	`id` varchar(36) NOT NULL,
	`toolId` varchar(36) NOT NULL,
	`revisionNo` bigint NOT NULL,
	`description` text,
	`inputSchemaJson` json NOT NULL,
	`outputSchemaJson` json,
	`schemaHash` varchar(128) NOT NULL,
	`riskMetadataJson` json,
	`revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
	`createdBy` varchar(128) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`publishedAt` datetime(3),
	CONSTRAINT `ToolSchemaRevision_id` PRIMARY KEY(`id`),
	CONSTRAINT `ToolSchemaRevision_tool_revisionNo_uq` UNIQUE(`toolId`,`revisionNo`)
);
--> statement-breakpoint
CREATE TABLE `Tool` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`providerId` varchar(36) NOT NULL,
	`toolKey` varchar(128) NOT NULL,
	`displayName` varchar(256) NOT NULL,
	`description` text,
	`riskClass` varchar(32) NOT NULL DEFAULT 'medium',
	`currentSchemaRevisionId` varchar(36),
	`lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `Tool_id` PRIMARY KEY(`id`),
	CONSTRAINT `Tool_tenant_providerId_toolKey_uq` UNIQUE(`tenantId`,`providerId`,`toolKey`)
);
--> statement-breakpoint
CREATE TABLE `observation` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`trace_id` varchar(36) NOT NULL,
	`span_id` varchar(36),
	`invocation_id` varchar(36),
	`kind` varchar(32) NOT NULL,
	`content_mode` varchar(32) NOT NULL DEFAULT 'metadata',
	`content_json` json,
	`contains_secret` json NOT NULL,
	`redaction_summary` varchar(256),
	`observed_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `observation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `span` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`trace_id` varchar(36) NOT NULL,
	`parent_span_id` varchar(36),
	`span_key` varchar(36) NOT NULL,
	`name` varchar(256) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`span_state` varchar(32) NOT NULL DEFAULT 'active',
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`attributes_json` json,
	`events_json` json,
	`version_no` varchar(36) NOT NULL DEFAULT '1',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `span_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trace` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`root_type` varchar(32) NOT NULL,
	`root_id` varchar(36) NOT NULL,
	`trace_key` varchar(128) NOT NULL,
	`root_span_id` varchar(36),
	`content_mode` varchar(32) NOT NULL DEFAULT 'metadata',
	`sampling_policy` varchar(32) NOT NULL DEFAULT 'always',
	`sampling_rate` json,
	`trace_state` varchar(32) NOT NULL DEFAULT 'active',
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`attributes_json` json,
	`version_no` varchar(36) NOT NULL DEFAULT '1',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `trace_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `capacity_snapshot` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`scope_type` varchar(32) NOT NULL,
	`scope_ref` varchar(128),
	`active_invocations` int NOT NULL DEFAULT 0,
	`queued_jobs` int NOT NULL DEFAULT 0,
	`cold_starts_last_hour` int NOT NULL DEFAULT 0,
	`limit_invocations_per_minute` int,
	`limit_tokens_per_minute` bigint,
	`limit_cost_per_hour_micros` bigint,
	`failure_count_last_hour` int NOT NULL DEFAULT 0,
	`snapshot_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `capacity_snapshot_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cost_aggregate` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`dimension` varchar(32) NOT NULL,
	`scope_type` varchar(32) NOT NULL,
	`scope_ref` varchar(128),
	`window_start` datetime(3) NOT NULL,
	`window_end` datetime(3) NOT NULL,
	`granularity` varchar(16) NOT NULL,
	`total_quantity` bigint NOT NULL,
	`total_cost_micros` bigint NOT NULL,
	`record_count` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `cost_aggregate_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_dim_scope_window_granularity_uq` UNIQUE(`tenant_id`,`dimension`,`scope_type`,`scope_ref`,`window_start`,`granularity`)
);
--> statement-breakpoint
CREATE TABLE `service_level_indicator` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`scope_type` varchar(32) NOT NULL,
	`scope_ref` varchar(128),
	`indicator_key` varchar(64) NOT NULL,
	`indicator_value` decimal(20,6) NOT NULL,
	`threshold_value` decimal(20,6),
	`breach` boolean NOT NULL DEFAULT false,
	`alert_invocation_id` varchar(36),
	`alert_trace_id` varchar(36),
	`error_code` varchar(64),
	`measured_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `service_level_indicator_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `usage_record` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`dimension` varchar(32) NOT NULL,
	`scope_type` varchar(32) NOT NULL,
	`scope_ref` varchar(128),
	`agent_revision_id` varchar(36),
	`model_ref` varchar(128),
	`tool_provider_id` varchar(36),
	`environment_id` varchar(36),
	`job_id` varchar(36),
	`invocation_id` varchar(36),
	`quantity` bigint NOT NULL,
	`unit_cost_micros` bigint,
	`total_cost_micros` bigint,
	`observed_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `usage_record_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `UserActionRequest` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`turnId` varchar(36) NOT NULL,
	`invocationId` varchar(36) NOT NULL,
	`toolCallId` varchar(36),
	`itemId` varchar(36),
	`requestType` enum('confirmation','auth','grant','input') NOT NULL,
	`purpose` varchar(64),
	`requestState` enum('pending','resolved','expired') NOT NULL DEFAULT 'pending',
	`promptJson` json NOT NULL,
	`inputSchemaJson` json,
	`authStateHash` varchar(128),
	`nonceHash` varchar(128),
	`expiresAt` datetime(3),
	`resolution` enum('approve','deny','submit','cancel'),
	`resolvedBy` varchar(36),
	`resolvedAt` datetime(3),
	`responseRedactedJson` json,
	`permissionDecisionId` varchar(36),
	`grantId` varchar(36),
	`versionNo` bigint NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `UserActionRequest_id` PRIMARY KEY(`id`),
	CONSTRAINT `UserActionRequest_item_id_uq` UNIQUE(`itemId`),
	CONSTRAINT `UserActionRequest_permissionDecision_id_uq` UNIQUE(`permissionDecisionId`)
);
--> statement-breakpoint
CREATE TABLE `WorkloadTokenRevocation` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`jti` varchar(64) NOT NULL,
	`tokenType` varchar(16) NOT NULL,
	`revokedBy` varchar(128) NOT NULL,
	`reason` text NOT NULL,
	`expiresAt` datetime(3) NOT NULL,
	`revokedAt` datetime(3) NOT NULL,
	CONSTRAINT `WorkloadTokenRevocation_id` PRIMARY KEY(`id`),
	CONSTRAINT `WorkloadTokenRevocation_tenant_jti_uq` UNIQUE(`tenantId`,`jti`)
);
--> statement-breakpoint
CREATE TABLE `WorkspaceMergeConflict` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`overlayId` varchar(36) NOT NULL,
	`conflictPathRef` varchar(512) NOT NULL,
	`pathFingerprint` varchar(128) NOT NULL,
	`beforeHash` varchar(128),
	`oursHash` varchar(128),
	`theirsHash` varchar(128),
	`conflictState` enum('reported','resolved','abandoned') NOT NULL DEFAULT 'reported',
	`conflictDetailsJson` json,
	`resolutionSummary` text,
	`reportedAt` datetime(3) NOT NULL,
	`resolvedAt` datetime(3),
	`versionNo` varchar(64) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `WorkspaceMergeConflict_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `WorkspaceOverlay` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`parentWorkspaceBindingId` varchar(36) NOT NULL,
	`relationId` varchar(36) NOT NULL,
	`overlayType` enum('git_worktree','cloud_overlay') NOT NULL,
	`overlayLocationRef` varchar(512) NOT NULL,
	`overlayFingerprint` varchar(128) NOT NULL,
	`baseRevisionRef` varchar(256),
	`overlayState` enum('active','merged','conflict','discarded') NOT NULL DEFAULT 'active',
	`taskDescription` text,
	`mergedRevisionRef` varchar(256),
	`mergedAt` datetime(3),
	`discardedAt` datetime(3),
	`versionNo` varchar(64) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `WorkspaceOverlay_id` PRIMARY KEY(`id`),
	CONSTRAINT `WorkspaceOverlay_tenant_binding_relation_uq` UNIQUE(`tenantId`,`parentWorkspaceBindingId`,`relationId`)
);
--> statement-breakpoint
CREATE TABLE `WorkspaceWriteLock` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`workspaceBindingId` varchar(36) NOT NULL,
	`holderInvocationId` varchar(36) NOT NULL,
	`holderRelationId` varchar(36),
	`pathRef` varchar(512) NOT NULL,
	`pathFingerprint` varchar(128) NOT NULL,
	`lockState` enum('acquired','released','expired','revoked') NOT NULL DEFAULT 'acquired',
	`acquiredAt` datetime(3) NOT NULL,
	`expiresAt` datetime(3),
	`releasedAt` datetime(3),
	`releaseReasonCode` varchar(64),
	`versionNo` varchar(64) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `WorkspaceWriteLock_id` PRIMARY KEY(`id`),
	CONSTRAINT `WorkspaceWriteLock_tenant_binding_path_idx` UNIQUE(`tenantId`,`workspaceBindingId`,`pathFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `Workspace` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`ownerUserId` varchar(36),
	`workspaceKey` varchar(128) NOT NULL,
	`displayName` varchar(256) NOT NULL,
	`description` text,
	`workspaceKind` enum('personal','project','shared','system') NOT NULL DEFAULT 'personal',
	`lifecycleState` enum('active','archived','deleted') NOT NULL DEFAULT 'active',
	`defaultEnvironmentDefinitionId` varchar(36),
	`defaultBindingId` varchar(36),
	`versionNo` varchar(64) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `Workspace_id` PRIMARY KEY(`id`),
	CONSTRAINT `Workspace_tenant_key_uq` UNIQUE(`tenantId`,`workspaceKey`)
);
--> statement-breakpoint
CREATE TABLE `WorkspaceAttachment` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`workspaceBindingId` varchar(36) NOT NULL,
	`resourceType` enum('file','directory','archive','database_snapshot','external_ref') NOT NULL,
	`resourceRef` varchar(512) NOT NULL,
	`resourceFingerprint` varchar(128),
	`displayRef` varchar(256),
	`accessMode` enum('read','read_write') NOT NULL DEFAULT 'read',
	`attachmentState` enum('attached','detached','expired') NOT NULL DEFAULT 'attached',
	`attachedBy` varchar(128) NOT NULL,
	`versionNo` varchar(64) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`expiresAt` datetime(3),
	CONSTRAINT `WorkspaceAttachment_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `WorkspaceAttachmentUse` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`turnId` varchar(36) NOT NULL,
	`workspaceAttachmentId` varchar(36) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `WorkspaceAttachmentUse_id` PRIMARY KEY(`id`),
	CONSTRAINT `WorkspaceAttachmentUse_turn_attachment_uq` UNIQUE(`turnId`,`workspaceAttachmentId`)
);
--> statement-breakpoint
CREATE TABLE `WorkspaceBinding` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`bindingType` enum('desktop','cloud','remote','sandbox') NOT NULL,
	`deviceId` varchar(36),
	`environmentDefinitionId` varchar(36),
	`locationRef` varchar(512) NOT NULL,
	`locationFingerprint` varchar(128),
	`bindingState` enum('active','inactive','revoked') NOT NULL DEFAULT 'active',
	`lastVerifiedAt` datetime(3),
	`versionNo` varchar(64) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `WorkspaceBinding_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ControlPlaneEventDelivery` (
	`id` varchar(36) NOT NULL,
	`eventId` varchar(36) NOT NULL,
	`consumerName` varchar(128) NOT NULL,
	`state` varchar(32) NOT NULL DEFAULT 'pending',
	`attemptCount` int NOT NULL DEFAULT 0,
	`nextAttemptAt` datetime(3),
	`lockedBy` varchar(128),
	`lockExpiresAt` datetime(3),
	`lastErrorCode` varchar(64),
	`lastErrorSummary` text,
	`completedAt` datetime(3),
	`deadLetteredAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `ControlPlaneEventDelivery_id` PRIMARY KEY(`id`),
	CONSTRAINT `ControlPlaneEventDelivery_event_consumer_uq` UNIQUE(`eventId`,`consumerName`)
);
--> statement-breakpoint
CREATE TABLE `ControlPlaneOutboxEvent` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`schemaVersion` varchar(8) NOT NULL DEFAULT '1.0',
	`eventKey` varchar(256) NOT NULL,
	`eventType` varchar(128) NOT NULL,
	`aggregateType` varchar(64) NOT NULL,
	`aggregateId` varchar(128) NOT NULL,
	`aggregateVersion` int NOT NULL DEFAULT 0,
	`payloadJson` json NOT NULL,
	`occurredAt` datetime(3) NOT NULL,
	`availableAt` datetime(3),
	CONSTRAINT `ControlPlaneOutboxEvent_id` PRIMARY KEY(`id`),
	CONSTRAINT `ControlPlaneOutboxEvent_eventKey_uq` UNIQUE(`eventKey`)
);
--> statement-breakpoint
CREATE TABLE `Artifact` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`digest` varchar(71) NOT NULL,
	`mediaType` varchar(255),
	`size` bigint unsigned,
	`contentRef` varchar(512),
	`sourceRevision` varchar(128),
	`buildMetadata` json,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `Artifact_id` PRIMARY KEY(`id`),
	CONSTRAINT `Artifact_tenant_digest_uq` UNIQUE(`tenantId`,`digest`)
);
--> statement-breakpoint
CREATE TABLE `ArtifactAttestation` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`artifactId` varchar(36),
	`artifactType` varchar(32) NOT NULL,
	`artifactRevisionId` varchar(36) NOT NULL,
	`artifactDigest` varchar(128) NOT NULL,
	`dsseEnvelopeRef` varchar(512),
	`sbomRef` varchar(512),
	`provenanceRef` varchar(512),
	`builderIdentity` varchar(256),
	`verificationState` enum('verified','failed') NOT NULL,
	`policyRevisionId` varchar(36),
	`sourceRevision` varchar(128),
	`buildPipeline` varchar(256),
	`dependencyLockFileHash` varchar(128),
	`buildTime` datetime(3),
	`scanSummaryJson` json,
	`failureCode` varchar(64),
	`verifiedAt` datetime(3),
	`attestationFormat` enum('in_toto_dsse') NOT NULL DEFAULT 'in_toto_dsse',
	`statementType` varchar(128),
	`predicateType` varchar(256),
	`bundleDigest` varchar(71),
	`subjectName` varchar(256),
	`subjectDigest` varchar(71),
	`verificationEngine` varchar(64),
	`verificationEngineVersion` varchar(32),
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `ArtifactAttestation_id` PRIMARY KEY(`id`),
	CONSTRAINT `ArtifactAttestation_tenant_type_rev_digest_env_uq` UNIQUE(`tenantId`,`artifactType`,`artifactRevisionId`,`artifactDigest`,`dsseEnvelopeRef`)
);
--> statement-breakpoint
CREATE TABLE `AttestationRevocationRecord` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`attestationId` varchar(36) NOT NULL,
	`revokedByType` enum('user','service','workload','system') NOT NULL,
	`revokedBy` varchar(128) NOT NULL,
	`reason` text NOT NULL,
	`requestId` varchar(64) NOT NULL,
	`revokedAt` datetime(3) NOT NULL,
	CONSTRAINT `AttestationRevocationRecord_id` PRIMARY KEY(`id`),
	CONSTRAINT `AttestationRevocationRecord_attestation_uq` UNIQUE(`attestationId`)
);
--> statement-breakpoint
CREATE TABLE `PublicationRecord` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`subjectType` enum('agent_revision','runtime_revision') NOT NULL,
	`subjectRevisionId` varchar(36) NOT NULL,
	`publicationSequence` bigint unsigned AUTO_INCREMENT NOT NULL,
	`evidenceSetDigest` varchar(71) NOT NULL,
	`attestationIds` json NOT NULL,
	`conformanceRunId` varchar(36),
	`approvals` json NOT NULL,
	`agentContractSnapshotId` varchar(36),
	`agentContractDigest` varchar(71),
	`agentCapabilityDigest` varchar(71),
	`agentContextDigest` varchar(71),
	`publishedByType` enum('user','service','workload','system') NOT NULL,
	`publishedBy` varchar(128) NOT NULL,
	`publishedAt` datetime(3) NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`idempotencyRecordId` varchar(36),
	CONSTRAINT `PublicationRecord_id` PRIMARY KEY(`id`),
	CONSTRAINT `PublicationRecord_subject_uq` UNIQUE(`subjectType`,`subjectRevisionId`),
	CONSTRAINT `PublicationRecord_sequence_uq` UNIQUE(`publicationSequence`),
	CONSTRAINT `PublicationRecord_idempotencyRecord_uq` UNIQUE(`idempotencyRecordId`)
);
--> statement-breakpoint
CREATE TABLE `WithdrawalRecord` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`publicationRecordId` varchar(36) NOT NULL,
	`subjectType` enum('agent_revision','runtime_revision') NOT NULL,
	`subjectRevisionId` varchar(36) NOT NULL,
	`reasonCode` varchar(64) NOT NULL,
	`reason` text NOT NULL,
	`withdrawnByType` enum('user','service','workload','system') NOT NULL,
	`withdrawnBy` varchar(128) NOT NULL,
	`withdrawnAt` datetime(3) NOT NULL,
	CONSTRAINT `WithdrawalRecord_id` PRIMARY KEY(`id`),
	CONSTRAINT `WithdrawalRecord_subject_uq` UNIQUE(`subjectType`,`subjectRevisionId`),
	CONSTRAINT `WithdrawalRecord_publicationRecord_uq` UNIQUE(`publicationRecordId`)
);
--> statement-breakpoint
CREATE TABLE `RouteActivation` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`routeId` varchar(36) NOT NULL,
	`routeRevisionId` varchar(36) NOT NULL,
	`routeSetId` varchar(36) NOT NULL,
	`activationSequence` bigint unsigned NOT NULL,
	`activationState` enum('active','disabled') NOT NULL,
	`previousRouteRevisionId` varchar(36),
	`previousRouteActivationId` varchar(36),
	`routeSetVersionNo` bigint unsigned NOT NULL,
	`activatedByType` enum('user','service','workload','system') NOT NULL,
	`activatedBy` varchar(128) NOT NULL,
	`reason` text NOT NULL,
	`requestId` varchar(64) NOT NULL,
	`idempotencyKey` varchar(256) NOT NULL,
	`activatedAt` datetime(3) NOT NULL,
	CONSTRAINT `RouteActivation_id` PRIMARY KEY(`id`),
	CONSTRAINT `RouteActivation_route_sequence_uq` UNIQUE(`routeId`,`activationSequence`),
	CONSTRAINT `RouteActivation_routeSet_idempotency_uq` UNIQUE(`routeSetId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `RouteRevision` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`routeId` varchar(36) NOT NULL,
	`routeSetId` varchar(36) NOT NULL,
	`routeKey` varchar(128) NOT NULL,
	`revisionNo` bigint unsigned NOT NULL,
	`agentRevisionId` varchar(36),
	`runtimeRevisionId` varchar(36),
	`agentEndpointRef` varchar(512),
	`agentIdentityMode` enum('none','bearer'),
	`agentCredentialRefId` varchar(36),
	`agentNetworkZone` varchar(32),
	`policyRevisionId` varchar(36),
	`modelPolicyRevisionId` varchar(36),
	`toolsetRevisionId` varchar(36),
	`trafficAllocationJson` json NOT NULL,
	`routeGroupId` varchar(128) NOT NULL DEFAULT 'primary',
	`selectorDigest` varchar(71) NOT NULL,
	`trafficWeight` int NOT NULL,
	`priorityNo` int NOT NULL,
	`effectiveFrom` datetime(3),
	`effectiveUntil` datetime(3),
	`eligibilityConditionsJson` json NOT NULL,
	`contentDigest` varchar(71) NOT NULL,
	`createdByType` enum('user','service','workload','system') NOT NULL,
	`createdBy` varchar(128) NOT NULL,
	`validatedAt` datetime(3) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `RouteRevision_id` PRIMARY KEY(`id`),
	CONSTRAINT `RouteRevision_route_revisionNo_uq` UNIQUE(`routeId`,`revisionNo`),
	CONSTRAINT `RouteRevision_route_content_uq` UNIQUE(`routeId`,`contentDigest`),
	CONSTRAINT `RouteRevision_exact_target_group_check` CHECK ((`runtimeRevisionId` IS NOT NULL AND TRIM(`runtimeRevisionId`) <> '' AND `agentRevisionId` IS NULL AND `agentEndpointRef` IS NULL AND `agentIdentityMode` IS NULL AND `agentCredentialRefId` IS NULL AND `agentNetworkZone` IS NULL) OR (`runtimeRevisionId` IS NULL AND `agentRevisionId` IS NOT NULL AND TRIM(`agentRevisionId`) <> '' AND `agentEndpointRef` IS NOT NULL AND TRIM(`agentEndpointRef`) <> '' AND `agentIdentityMode` IN ('none','bearer') AND `agentNetworkZone` IS NOT NULL AND TRIM(`agentNetworkZone`) <> '' AND ((`agentIdentityMode` = 'bearer' AND `agentCredentialRefId` IS NOT NULL AND TRIM(`agentCredentialRefId`) <> '') OR (`agentIdentityMode` = 'none' AND (`agentCredentialRefId` IS NULL OR TRIM(`agentCredentialRefId`) <> '')))))
);
--> statement-breakpoint
CREATE TABLE `RouteEligibilityProjection` (
	`routeId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`targetKind` enum('runtime','agent') NOT NULL,
	`targetIdentity` varchar(36) NOT NULL,
	`agentId` varchar(36),
	`routeSetId` varchar(36) NOT NULL,
	`routeScopeKey` varchar(128) NOT NULL,
	`routeSetVersionNo` bigint unsigned NOT NULL,
	`routeRevisionId` varchar(36) NOT NULL,
	`routeRevisionNo` bigint unsigned NOT NULL,
	`routeActivationId` varchar(36) NOT NULL,
	`routeActivationSequence` bigint unsigned NOT NULL,
	`activationState` enum('active','disabled') NOT NULL,
	`routeGroupId` varchar(128) NOT NULL,
	`selectorDigest` varchar(71) NOT NULL,
	`eligibilityConditionsJson` json NOT NULL,
	`specificity` int NOT NULL,
	`priorityNo` int NOT NULL,
	`trafficWeight` int NOT NULL,
	`effectiveFrom` datetime(3),
	`effectiveUntil` datetime(3),
	`agentRevisionId` varchar(36),
	`agentEndpointRef` varchar(512),
	`agentIdentityMode` enum('none','bearer'),
	`agentCredentialRefId` varchar(36),
	`agentNetworkZone` varchar(32),
	`agentRevisionState` varchar(32),
	`agentLifecycleState` varchar(32),
	`agentPublicationActive` int,
	`agentEvidenceValid` int,
	`agentPublicationRecordId` varchar(36),
	`agentContractSnapshotId` varchar(36),
	`agentContractDigest` varchar(71),
	`agentContextDigest` varchar(71),
	`runtimeRevisionId` varchar(36),
	`runtimeRevisionState` varchar(32),
	`runtimeLifecycleState` varchar(32),
	`runtimePublicationActive` int,
	`runtimeEvidenceValid` int,
	`runtimeConformanceValid` int,
	`runtimeEvidenceKind` enum('hosted_artifact','external_endpoint'),
	`runtimePublicationRecordId` varchar(36),
	`runtimeAttestationIds` json,
	`conformanceRunId` varchar(36),
	`runtimeArtifactId` varchar(36),
	`runtimeArtifactDigest` varchar(71),
	`runtimeConfigDigest` varchar(71),
	`runtimeTargetDigest` varchar(71),
	`capabilityCompatibilityDigest` varchar(71),
	`policyRevisionId` varchar(36),
	`policyRevisionState` varchar(32),
	`sourceEventId` varchar(36),
	`sourceAggregateVersion` int,
	`invalidReason` varchar(255),
	`routeContentDigest` varchar(71) NOT NULL,
	`eligibilityState` enum('eligible','ineligible','pending_rebuild') NOT NULL,
	`projectionContentDigest` varchar(71) NOT NULL,
	`projectionVersionNo` bigint unsigned NOT NULL,
	`lastRebuiltAt` datetime(3) NOT NULL,
	CONSTRAINT `RouteEligibilityProjection_routeId` PRIMARY KEY(`routeId`),
	CONSTRAINT `RouteEligibilityProjection_revision_activation_uq` UNIQUE(`routeRevisionId`,`routeActivationId`),
	CONSTRAINT `RouteEligibilityProjection_target_identity_check` CHECK (TRIM(`targetIdentity`) <> ''),
	CONSTRAINT `RouteEligibilityProjection_target_consistency_check` CHECK ((`targetKind` = 'runtime' AND `targetIdentity` = 'runtime' AND `agentId` IS NULL) OR (`targetKind` = 'agent' AND `targetIdentity` = `agentId` AND `agentId` IS NOT NULL AND TRIM(`agentId`) <> '')),
	CONSTRAINT `RouteEligibilityProjection_target_group_exclusion_check` CHECK ((`targetKind` = 'agent' AND `agentRevisionId` IS NOT NULL AND TRIM(`agentRevisionId`) <> '' AND `runtimeRevisionId` IS NULL AND `runtimeRevisionState` IS NULL AND `runtimeLifecycleState` IS NULL AND `runtimePublicationActive` IS NULL AND `runtimeEvidenceValid` IS NULL AND `runtimeConformanceValid` IS NULL AND `runtimeEvidenceKind` IS NULL AND `runtimePublicationRecordId` IS NULL AND `runtimeAttestationIds` IS NULL AND `conformanceRunId` IS NULL AND `runtimeArtifactId` IS NULL AND `runtimeArtifactDigest` IS NULL AND `runtimeConfigDigest` IS NULL AND `runtimeTargetDigest` IS NULL AND `capabilityCompatibilityDigest` IS NULL) OR (`targetKind` = 'runtime' AND `runtimeRevisionId` IS NOT NULL AND TRIM(`runtimeRevisionId`) <> '' AND `agentRevisionId` IS NULL AND `agentEndpointRef` IS NULL AND `agentIdentityMode` IS NULL AND `agentCredentialRefId` IS NULL AND `agentNetworkZone` IS NULL AND `agentRevisionState` IS NULL AND `agentLifecycleState` IS NULL AND `agentPublicationActive` IS NULL AND `agentEvidenceValid` IS NULL AND `agentPublicationRecordId` IS NULL AND `agentContractSnapshotId` IS NULL AND `agentContractDigest` IS NULL AND `agentContextDigest` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `RuntimeConformanceCaseResult` (
	`id` varchar(36) NOT NULL,
	`runId` varchar(36) NOT NULL,
	`caseId` varchar(128) NOT NULL,
	`passed` boolean NOT NULL,
	`reason` text,
	`evidenceDigest` varchar(71) NOT NULL,
	CONSTRAINT `RuntimeConformanceCaseResult_id` PRIMARY KEY(`id`),
	CONSTRAINT `RuntimeConformanceCaseResult_run_case_uq` UNIQUE(`runId`,`caseId`)
);
--> statement-breakpoint
CREATE TABLE `RuntimeConformanceRun` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`runtimeRevisionId` varchar(36) NOT NULL,
	`runtimeTargetDigest` varchar(71) NOT NULL,
	`runtimeConfigDigest` varchar(71) NOT NULL,
	`protocolContractRevision` varchar(128) NOT NULL,
	`suiteRevision` varchar(128) NOT NULL,
	`runnerArtifactDigest` varchar(71) NOT NULL,
	`runnerIdentity` varchar(255) NOT NULL,
	`testEnvironmentRevision` varchar(128) NOT NULL,
	`startedAt` datetime(3) NOT NULL,
	`completedAt` datetime(3) NOT NULL,
	`overallResult` enum('passed','failed','error','cancelled') NOT NULL,
	`conformanceFormat` enum('standard_dsse') NOT NULL DEFAULT 'standard_dsse',
	`evidenceManifestDigest` varchar(71) NOT NULL,
	`envelopeDigest` varchar(71) NOT NULL,
	`envelopeJson` text NOT NULL,
	`payloadDigest` varchar(71) NOT NULL,
	`signingKeyId` varchar(255) NOT NULL,
	`verificationEngine` varchar(64) NOT NULL,
	`verificationEngineVersion` varchar(32) NOT NULL,
	`predicateType` varchar(255) NOT NULL,
	`verifiedAt` datetime(3) NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`requestId` varchar(64) NOT NULL,
	`recordedAt` datetime(3) NOT NULL,
	CONSTRAINT `RuntimeConformanceRun_id` PRIMARY KEY(`id`),
	CONSTRAINT `RuntimeConformanceRun_idempotency_uq` UNIQUE(`tenantId`,`runtimeRevisionId`,`idempotencyKey`),
	CONSTRAINT `RuntimeConformanceRun_evidence_uq` UNIQUE(`tenantId`,`evidenceManifestDigest`)
);
--> statement-breakpoint
CREATE TABLE `HostedProvisioningRequest` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`requesterId` varchar(36) NOT NULL,
	`routeScopeKey` varchar(64) NOT NULL,
	`state` enum('pending','running','ready','retryable_failed','permanent_failed','cancelled') NOT NULL DEFAULT 'pending',
	`currentStep` varchar(64),
	`attemptCount` int NOT NULL DEFAULT 0,
	`nextAttemptAt` datetime(3),
	`leaseOwner` varchar(128),
	`leaseExpiresAt` datetime(3),
	`lastError` varchar(512),
	`lastAttemptAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	`stepRuntimeId` varchar(36),
	`stepRuntimeRevisionId` varchar(36),
	`stepRuntimeArtifactId` varchar(36),
	`stepRuntimeAttestationIds` json,
	`stepRuntimePublicationRecordId` varchar(36),
	`stepConformanceRunId` varchar(36),
	`stepRouteSetId` varchar(36),
	`stepRouteSetVersionNo` int,
	`stepRouteId` varchar(36),
	`stepRouteRevisionId` varchar(36),
	`stepRouteActivationId` varchar(36),
	`stepProjectionVersionNo` int,
	`workflowVersion` varchar(16) NOT NULL DEFAULT '3.0',
	`lastCompletedStep` varchar(64),
	CONSTRAINT `HostedProvisioningRequest_id` PRIMARY KEY(`id`),
	CONSTRAINT `HostedProvisioningRequest_active_uq` UNIQUE(`tenantId`,`routeScopeKey`)
);
--> statement-breakpoint
ALTER TABLE `RuntimeArtifact` ADD CONSTRAINT `RuntimeArtifact_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `admin_export` ADD CONSTRAINT `admin_export_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentContractCapability` ADD CONSTRAINT `AgentContractCapability_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `AgentContractSnapshot`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentContractInvocationContext` ADD CONSTRAINT `AgentContractInvocationContext_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `AgentContractSnapshot`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentContractSnapshot` ADD CONSTRAINT `AgentContractSnapshot_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentContractSnapshot` ADD CONSTRAINT `AgentContractSnapshot_agentId_Agent_id_fk` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentRevision` ADD CONSTRAINT `AgentRevision_agentId_Agent_id_fk` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Agent` ADD CONSTRAINT `Agent_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentCallAttempt` ADD CONSTRAINT `AgentCallAttempt_callId_AgentCall_id_fk` FOREIGN KEY (`callId`) REFERENCES `AgentCall`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentCallBinding` ADD CONSTRAINT `AgentCallBinding_callId_AgentCall_id_fk` FOREIGN KEY (`callId`) REFERENCES `AgentCall`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` ADD CONSTRAINT `AgentCallEventIngress_callId_AgentCall_id_fk` FOREIGN KEY (`callId`) REFERENCES `AgentCall`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentCall` ADD CONSTRAINT `AgentCall_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentCall` ADD CONSTRAINT `AgentCall_parentInvocationId_Invocation_id_fk` FOREIGN KEY (`parentInvocationId`) REFERENCES `Invocation`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AgentSessionBinding` ADD CONSTRAINT `AgentSessionBinding_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AuditEvent` ADD CONSTRAINT `AuditEvent_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RoleActionBinding` ADD CONSTRAINT `RoleActionBinding_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RoleActionBinding` ADD CONSTRAINT `RoleActionBinding_principalBindingId_PrincipalBinding_id_fk` FOREIGN KEY (`principalBindingId`) REFERENCES `PrincipalBinding`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `CapabilityUse` ADD CONSTRAINT `CapabilityUse_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `CatalogEntry` ADD CONSTRAINT `CatalogEntry_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `CatalogRevision` ADD CONSTRAINT `CatalogRevision_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ContextCheckpoint` ADD CONSTRAINT `ContextCheckpoint_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Goal` ADD CONSTRAINT `Goal_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `InvocationCommand` ADD CONSTRAINT `InvocationCommand_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PendingInput` ADD CONSTRAINT `PendingInput_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ThreadEvent` ADD CONSTRAINT `ThreadEvent_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ThreadItem` ADD CONSTRAINT `ThreadItem_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ThreadRelation` ADD CONSTRAINT `ThreadRelation_parentThreadId_Thread_id_fk` FOREIGN KEY (`parentThreadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ThreadRelation` ADD CONSTRAINT `ThreadRelation_childThreadId_Thread_id_fk` FOREIGN KEY (`childThreadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Thread` ADD CONSTRAINT `Thread_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Turn` ADD CONSTRAINT `Turn_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `DeletionRequest` ADD CONSTRAINT `DeletionRequest_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `DeletionStep` ADD CONSTRAINT `DeletionStep_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `DeletionStep` ADD CONSTRAINT `DeletionStep_requestId_DeletionRequest_id_fk` FOREIGN KEY (`requestId`) REFERENCES `DeletionRequest`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `DeploymentRouteSet` ADD CONSTRAINT `DeploymentRouteSet_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `DeploymentRoute` ADD CONSTRAINT `DeploymentRoute_routeSetId_DeploymentRouteSet_id_fk` FOREIGN KEY (`routeSetId`) REFERENCES `DeploymentRouteSet`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Device` ADD CONSTRAINT `Device_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Device` ADD CONSTRAINT `Device_userId_UserIdentity_id_fk` FOREIGN KEY (`userId`) REFERENCES `UserIdentity`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EffectRecord` ADD CONSTRAINT `EffectRecord_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EffectTarget` ADD CONSTRAINT `EffectTarget_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EffectTarget` ADD CONSTRAINT `EffectTarget_effectRecordId_EffectRecord_id_fk` FOREIGN KEY (`effectRecordId`) REFERENCES `EffectRecord`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EnvironmentChangeRequest` ADD CONSTRAINT `EnvironmentChangeRequest_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EnvironmentChangeRequest` ADD CONSTRAINT `EnvironmentChangeRequest_fromEnvironmentDefinitionId_Environ5abe` FOREIGN KEY (`fromEnvironmentDefinitionId`) REFERENCES `EnvironmentDefinition`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EnvironmentChangeRequest` ADD CONSTRAINT `EnvironmentChangeRequest_requestedEnvironmentDefinitionId_Ene6d1` FOREIGN KEY (`requestedEnvironmentDefinitionId`) REFERENCES `EnvironmentDefinition`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EnvironmentDefinition` ADD CONSTRAINT `EnvironmentDefinition_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EnvironmentLease` ADD CONSTRAINT `EnvironmentLease_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EnvironmentLease` ADD CONSTRAINT `EnvironmentLease_invocationId_Invocation_id_fk` FOREIGN KEY (`invocationId`) REFERENCES `Invocation`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `EnvironmentLease` ADD CONSTRAINT `EnvironmentLease_environmentDefinitionId_EnvironmentDefinitie317` FOREIGN KEY (`environmentDefinitionId`) REFERENCES `EnvironmentDefinition`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluation_case` ADD CONSTRAINT `evaluation_case_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluation_case` ADD CONSTRAINT `evaluation_case_run_id_evaluation_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `evaluation_run`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluation_result` ADD CONSTRAINT `evaluation_result_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluation_result` ADD CONSTRAINT `evaluation_result_run_id_evaluation_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `evaluation_run`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluation_result` ADD CONSTRAINT `evaluation_result_case_id_evaluation_case_id_fk` FOREIGN KEY (`case_id`) REFERENCES `evaluation_case`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluation_run` ADD CONSTRAINT `evaluation_run_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluation_run` ADD CONSTRAINT `evaluation_run_job_id_Job_id_fk` FOREIGN KEY (`job_id`) REFERENCES `Job`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `FileChange` ADD CONSTRAINT `FileChange_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `FileChange` ADD CONSTRAINT `FileChange_workspaceBindingId_WorkspaceBinding_id_fk` FOREIGN KEY (`workspaceBindingId`) REFERENCES `WorkspaceBinding`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `FilesystemCheckpoint` ADD CONSTRAINT `FilesystemCheckpoint_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `FilesystemCheckpoint` ADD CONSTRAINT `FilesystemCheckpoint_workspaceBindingId_WorkspaceBinding_id_fk` FOREIGN KEY (`workspaceBindingId`) REFERENCES `WorkspaceBinding`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `GovernanceConfigRevision` ADD CONSTRAINT `GovernanceConfigRevision_configSetId_GovernanceConfigSet_id_fk` FOREIGN KEY (`configSetId`) REFERENCES `GovernanceConfigSet`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `GovernanceConfigSet` ADD CONSTRAINT `GovernanceConfigSet_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `IdempotencyRecord` ADD CONSTRAINT `IdempotencyRecord_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PrincipalBinding` ADD CONSTRAINT `PrincipalBinding_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PrincipalBinding` ADD CONSTRAINT `PrincipalBinding_userIdentityId_UserIdentity_id_fk` FOREIGN KEY (`userIdentityId`) REFERENCES `UserIdentity`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `UserIdentity` ADD CONSTRAINT `UserIdentity_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `JobCommand` ADD CONSTRAINT `JobCommand_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `JobEvent` ADD CONSTRAINT `JobEvent_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `JobResultProjection` ADD CONSTRAINT `JobResultProjection_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Job` ADD CONSTRAINT `Job_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `KnowledgeBase` ADD CONSTRAINT `KnowledgeBase_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_documentRevisionId_KnowledgeDocumentRevision_85e8` FOREIGN KEY (`documentRevisionId`) REFERENCES `KnowledgeDocumentRevision`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `KnowledgeDocument` ADD CONSTRAINT `KnowledgeDocument_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `KnowledgeDocument` ADD CONSTRAINT `KnowledgeDocument_knowledgeBaseId_KnowledgeBase_id_fk` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `KnowledgeBase`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `KnowledgeDocumentRevision` ADD CONSTRAINT `KnowledgeDocumentRevision_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `KnowledgeDocumentRevision` ADD CONSTRAINT `KnowledgeDocumentRevision_documentId_KnowledgeDocument_id_fk` FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `KnowledgeIndex` ADD CONSTRAINT `KnowledgeIndex_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `KnowledgeIndex` ADD CONSTRAINT `KnowledgeIndex_chunkId_KnowledgeChunk_id_fk` FOREIGN KEY (`chunkId`) REFERENCES `KnowledgeChunk`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `MemoryCandidate` ADD CONSTRAINT `MemoryCandidate_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `MemoryEntry` ADD CONSTRAINT `MemoryEntry_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `MemoryIndex` ADD CONSTRAINT `MemoryIndex_memoryEntryId_MemoryEntry_id_fk` FOREIGN KEY (`memoryEntryId`) REFERENCES `MemoryEntry`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `MemorySource` ADD CONSTRAINT `MemorySource_memoryEntryId_MemoryEntry_id_fk` FOREIGN KEY (`memoryEntryId`) REFERENCES `MemoryEntry`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Grant` ADD CONSTRAINT `Grant_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Grant` ADD CONSTRAINT `Grant_credentialRefId_CredentialRef_id_fk` FOREIGN KEY (`credentialRefId`) REFERENCES `CredentialRef`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PermissionDecision` ADD CONSTRAINT `PermissionDecision_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PolicyRevision` ADD CONSTRAINT `PolicyRevision_policySetId_PolicySet_id_fk` FOREIGN KEY (`policySetId`) REFERENCES `PolicySet`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PolicySet` ADD CONSTRAINT `PolicySet_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Policy` ADD CONSTRAINT `Policy_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ThreadListProjection` ADD CONSTRAINT `ThreadListProjection_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `TurnTimelineProjection` ADD CONSTRAINT `TurnTimelineProjection_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RecoveryDrillCheck` ADD CONSTRAINT `RecoveryDrillCheck_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RecoveryDrillCheck` ADD CONSTRAINT `RecoveryDrillCheck_drillId_RecoveryDrill_id_fk` FOREIGN KEY (`drillId`) REFERENCES `RecoveryDrill`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RecoveryDrill` ADD CONSTRAINT `RecoveryDrill_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `LegalHold` ADD CONSTRAINT `LegalHold_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RetentionPolicy` ADD CONSTRAINT `RetentionPolicy_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RuntimeRevision` ADD CONSTRAINT `RuntimeRevision_runtimeId_Runtime_id_fk` FOREIGN KEY (`runtimeId`) REFERENCES `Runtime`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Runtime` ADD CONSTRAINT `Runtime_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD CONSTRAINT `ExecutionBinding_invocationId_Invocation_id_fk` FOREIGN KEY (`invocationId`) REFERENCES `Invocation`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `InvocationAttempt` ADD CONSTRAINT `InvocationAttempt_invocationId_Invocation_id_fk` FOREIGN KEY (`invocationId`) REFERENCES `Invocation`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Invocation` ADD CONSTRAINT `Invocation_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RuntimeEventIngress` ADD CONSTRAINT `RuntimeEventIngress_invocationId_Invocation_id_fk` FOREIGN KEY (`invocationId`) REFERENCES `Invocation`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RuntimeEventIngress` ADD CONSTRAINT `RuntimeEventIngress_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RuntimeSessionBinding` ADD CONSTRAINT `RuntimeSessionBinding_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `IncidentContainment` ADD CONSTRAINT `IncidentContainment_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `IncidentContainment` ADD CONSTRAINT `IncidentContainment_incidentId_SecurityIncident_id_fk` FOREIGN KEY (`incidentId`) REFERENCES `SecurityIncident`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `SecurityIncident` ADD CONSTRAINT `SecurityIncident_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Skill` ADD CONSTRAINT `Skill_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `SkillVersion` ADD CONSTRAINT `SkillVersion_skillId_Skill_id_fk` FOREIGN KEY (`skillId`) REFERENCES `Skill`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `SkillSyncBinding` ADD CONSTRAINT `SkillSyncBinding_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `SkillSyncBinding` ADD CONSTRAINT `SkillSyncBinding_localSkillId_Skill_id_fk` FOREIGN KEY (`localSkillId`) REFERENCES `Skill`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `SkillSyncBinding` ADD CONSTRAINT `SkillSyncBinding_localSkillVersionId_SkillVersion_id_fk` FOREIGN KEY (`localSkillVersionId`) REFERENCES `SkillVersion`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `CapabilityReview` ADD CONSTRAINT `CapabilityReview_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ToolCall` ADD CONSTRAINT `ToolCall_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Connection` ADD CONSTRAINT `Connection_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `CredentialRef` ADD CONSTRAINT `CredentialRef_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `CredentialRef` ADD CONSTRAINT `CredentialRef_connectionId_Connection_id_fk` FOREIGN KEY (`connectionId`) REFERENCES `Connection`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ToolProvider` ADD CONSTRAINT `ToolProvider_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ToolProvider` ADD CONSTRAINT `ToolProvider_connectionId_Connection_id_fk` FOREIGN KEY (`connectionId`) REFERENCES `Connection`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ToolSchemaRevision` ADD CONSTRAINT `ToolSchemaRevision_toolId_Tool_id_fk` FOREIGN KEY (`toolId`) REFERENCES `Tool`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Tool` ADD CONSTRAINT `Tool_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Tool` ADD CONSTRAINT `Tool_providerId_ToolProvider_id_fk` FOREIGN KEY (`providerId`) REFERENCES `ToolProvider`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `observation` ADD CONSTRAINT `observation_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `span` ADD CONSTRAINT `span_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `trace` ADD CONSTRAINT `trace_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capacity_snapshot` ADD CONSTRAINT `capacity_snapshot_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cost_aggregate` ADD CONSTRAINT `cost_aggregate_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_level_indicator` ADD CONSTRAINT `service_level_indicator_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_record` ADD CONSTRAINT `usage_record_tenant_id_Tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `UserActionRequest` ADD CONSTRAINT `UserActionRequest_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkloadTokenRevocation` ADD CONSTRAINT `WorkloadTokenRevocation_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceMergeConflict` ADD CONSTRAINT `WorkspaceMergeConflict_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceMergeConflict` ADD CONSTRAINT `WorkspaceMergeConflict_overlayId_WorkspaceOverlay_id_fk` FOREIGN KEY (`overlayId`) REFERENCES `WorkspaceOverlay`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceOverlay` ADD CONSTRAINT `WorkspaceOverlay_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceOverlay` ADD CONSTRAINT `WorkspaceOverlay_parentWorkspaceBindingId_WorkspaceBinding_id_fk` FOREIGN KEY (`parentWorkspaceBindingId`) REFERENCES `WorkspaceBinding`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceOverlay` ADD CONSTRAINT `WorkspaceOverlay_relationId_ThreadRelation_id_fk` FOREIGN KEY (`relationId`) REFERENCES `ThreadRelation`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceWriteLock` ADD CONSTRAINT `WorkspaceWriteLock_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceWriteLock` ADD CONSTRAINT `WorkspaceWriteLock_workspaceBindingId_WorkspaceBinding_id_fk` FOREIGN KEY (`workspaceBindingId`) REFERENCES `WorkspaceBinding`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceWriteLock` ADD CONSTRAINT `WorkspaceWriteLock_holderInvocationId_Invocation_id_fk` FOREIGN KEY (`holderInvocationId`) REFERENCES `Invocation`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Workspace` ADD CONSTRAINT `Workspace_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceAttachment` ADD CONSTRAINT `WorkspaceAttachment_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceAttachment` ADD CONSTRAINT `WorkspaceAttachment_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceAttachment` ADD CONSTRAINT `WorkspaceAttachment_workspaceBindingId_WorkspaceBinding_id_fk` FOREIGN KEY (`workspaceBindingId`) REFERENCES `WorkspaceBinding`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceAttachmentUse` ADD CONSTRAINT `WorkspaceAttachmentUse_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceAttachmentUse` ADD CONSTRAINT `WorkspaceAttachmentUse_workspaceAttachmentId_WorkspaceAttach5f4d` FOREIGN KEY (`workspaceAttachmentId`) REFERENCES `WorkspaceAttachment`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceBinding` ADD CONSTRAINT `WorkspaceBinding_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceBinding` ADD CONSTRAINT `WorkspaceBinding_workspaceId_Workspace_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WorkspaceBinding` ADD CONSTRAINT `WorkspaceBinding_deviceId_Device_id_fk` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ArtifactAttestation` ADD CONSTRAINT `ArtifactAttestation_artifactId_Artifact_id_fk` FOREIGN KEY (`artifactId`) REFERENCES `Artifact`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AttestationRevocationRecord` ADD CONSTRAINT `AttestationRevocationRecord_attestationId_ArtifactAttestatiob0ec` FOREIGN KEY (`attestationId`) REFERENCES `ArtifactAttestation`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `WithdrawalRecord` ADD CONSTRAINT `WithdrawalRecord_publicationRecordId_PublicationRecord_id_fk` FOREIGN KEY (`publicationRecordId`) REFERENCES `PublicationRecord`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RuntimeConformanceCaseResult` ADD CONSTRAINT `RuntimeConformanceCaseResult_runId_RuntimeConformanceRun_id_fk` FOREIGN KEY (`runId`) REFERENCES `RuntimeConformanceRun`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `RuntimeArtifact_tenant_invocation_idx` ON `RuntimeArtifact` (`tenantId`,`invocationId`);--> statement-breakpoint
CREATE INDEX `RuntimeArtifact_tenant_thread_idx` ON `RuntimeArtifact` (`tenantId`,`threadId`);--> statement-breakpoint
CREATE INDEX `RuntimeArtifact_tenant_job_idx` ON `RuntimeArtifact` (`tenantId`,`jobId`);--> statement-breakpoint
CREATE INDEX `RuntimeArtifact_tenant_expires_idx` ON `RuntimeArtifact` (`tenantId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `tenant_status_idx` ON `admin_export` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `tenant_kind_idx` ON `admin_export` (`tenant_id`,`export_kind`);--> statement-breakpoint
CREATE INDEX `tenant_requested_by_idx` ON `admin_export` (`tenant_id`,`requested_by`);--> statement-breakpoint
CREATE INDEX `AgentContractSnapshot_tenant_agent_idx` ON `AgentContractSnapshot` (`tenantId`,`agentId`);--> statement-breakpoint
CREATE INDEX `AgentContractSnapshot_agent_idx` ON `AgentContractSnapshot` (`agentId`);--> statement-breakpoint
CREATE INDEX `AgentRevision_agent_state_idx` ON `AgentRevision` (`agentId`,`revisionState`);--> statement-breakpoint
CREATE INDEX `Agent_tenant_lifecycle_updated_idx` ON `Agent` (`tenantId`,`lifecycleState`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `AgentCallAttempt_call_state_idx` ON `AgentCallAttempt` (`callId`,`attemptState`);--> statement-breakpoint
CREATE INDEX `AgentCallBinding_tenant_idx` ON `AgentCallBinding` (`tenantId`);--> statement-breakpoint
CREATE INDEX `AgentCallBinding_agentRevision_idx` ON `AgentCallBinding` (`agentRevisionId`);--> statement-breakpoint
CREATE INDEX `AgentCallBinding_routeRevision_idx` ON `AgentCallBinding` (`routeRevisionId`);--> statement-breakpoint
CREATE INDEX `AgentCallEventIngress_call_state_idx` ON `AgentCallEventIngress` (`callId`,`ingressState`);--> statement-breakpoint
CREATE INDEX `AgentCall_tenant_state_idx` ON `AgentCall` (`tenantId`,`state`);--> statement-breakpoint
CREATE INDEX `AgentCall_parent_idx` ON `AgentCall` (`parentInvocationId`);--> statement-breakpoint
CREATE INDEX `AgentCall_agent_idx` ON `AgentCall` (`agentId`);--> statement-breakpoint
CREATE INDEX `AgentSessionBinding_thread_idx` ON `AgentSessionBinding` (`threadId`);--> statement-breakpoint
CREATE INDEX `AgentSessionBinding_agent_idx` ON `AgentSessionBinding` (`agentId`);--> statement-breakpoint
CREATE INDEX `AuditEvent_tenant_occurred_idx` ON `AuditEvent` (`tenantId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `AuditEvent_tenant_actor_idx` ON `AuditEvent` (`tenantId`,`actorType`,`actorId`);--> statement-breakpoint
CREATE INDEX `AuditEvent_tenant_target_idx` ON `AuditEvent` (`tenantId`,`targetType`,`targetId`);--> statement-breakpoint
CREATE INDEX `AuditEvent_tenant_action_idx` ON `AuditEvent` (`tenantId`,`actionType`);--> statement-breakpoint
CREATE INDEX `RoleActionBinding_tenant_principal_idx` ON `RoleActionBinding` (`tenantId`,`principalBindingId`);--> statement-breakpoint
CREATE INDEX `RoleActionBinding_tenant_action_idx` ON `RoleActionBinding` (`tenantId`,`actionCode`);--> statement-breakpoint
CREATE INDEX `CapabilityUse_tenant_invocation_idx` ON `CapabilityUse` (`tenantId`,`invocationId`);--> statement-breakpoint
CREATE INDEX `CapabilityUse_tenant_type_capability_idx` ON `CapabilityUse` (`tenantId`,`capabilityType`,`capabilityId`);--> statement-breakpoint
CREATE INDEX `CatalogEntry_tenant_resourceType_lifecycle_idx` ON `CatalogEntry` (`tenantId`,`resourceType`,`lifecycleState`);--> statement-breakpoint
CREATE INDEX `CatalogEntry_tenant_catalogRevision_idx` ON `CatalogEntry` (`tenantId`,`catalogRevision`);--> statement-breakpoint
CREATE INDEX `ContextCheckpoint_tenant_invocation_created_idx` ON `ContextCheckpoint` (`tenantId`,`invocationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ContextCheckpoint_tenant_expires_idx` ON `ContextCheckpoint` (`tenantId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `Goal_thread_state_idx` ON `Goal` (`threadId`,`goalState`);--> statement-breakpoint
CREATE INDEX `InvocationCommand_thread_turn_idx` ON `InvocationCommand` (`threadId`,`turnId`);--> statement-breakpoint
CREATE INDEX `InvocationCommand_invocation_idx` ON `InvocationCommand` (`invocationId`);--> statement-breakpoint
CREATE INDEX `InvocationCommand_dispatch_retry_idx` ON `InvocationCommand` (`commandState`,`nextDispatchAt`);--> statement-breakpoint
CREATE INDEX `InvocationCommand_dispatch_lease_idx` ON `InvocationCommand` (`dispatchLeaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `PendingInput_thread_state_position_idx` ON `PendingInput` (`threadId`,`inputState`,`queuePosition`);--> statement-breakpoint
CREATE INDEX `ThreadEvent_thread_occurred_id_idx` ON `ThreadEvent` (`threadId`,`occurredAt`,`id`);--> statement-breakpoint
CREATE INDEX `ThreadEvent_turn_sequence_idx` ON `ThreadEvent` (`turnId`,`eventSequence`);--> statement-breakpoint
CREATE INDEX `ThreadEvent_invocation_sequence_idx` ON `ThreadEvent` (`invocationId`,`eventSequence`);--> statement-breakpoint
CREATE INDEX `ThreadItem_thread_turn_sequence_idx` ON `ThreadItem` (`threadId`,`turnId`,`itemSequence`);--> statement-breakpoint
CREATE INDEX `ThreadItem_invocation_idx` ON `ThreadItem` (`invocationId`);--> statement-breakpoint
CREATE INDEX `ThreadRelation_parent_state_idx` ON `ThreadRelation` (`parentThreadId`,`relationState`);--> statement-breakpoint
CREATE INDEX `ThreadRelation_child_idx` ON `ThreadRelation` (`childThreadId`);--> statement-breakpoint
CREATE INDEX `Thread_tenant_owner_lifecycle_activity_idx` ON `Thread` (`tenantId`,`ownerUserId`,`lifecycleState`,`lastActivityAt`);--> statement-breakpoint
CREATE INDEX `Turn_thread_state_accepted_idx` ON `Turn` (`threadId`,`turnState`,`acceptedAt`);--> statement-breakpoint
CREATE INDEX `DeletionRequest_tenant_subject_idx` ON `DeletionRequest` (`tenantId`,`subjectType`,`subjectId`);--> statement-breakpoint
CREATE INDEX `DeletionRequest_tenant_state_idx` ON `DeletionRequest` (`tenantId`,`requestState`);--> statement-breakpoint
CREATE INDEX `DeletionRequest_tenant_requested_by_idx` ON `DeletionRequest` (`tenantId`,`requestedBy`);--> statement-breakpoint
CREATE INDEX `DeletionStep_tenant_request_idx` ON `DeletionStep` (`tenantId`,`requestId`);--> statement-breakpoint
CREATE INDEX `DeletionStep_request_state_idx` ON `DeletionStep` (`requestId`,`stepState`);--> statement-breakpoint
CREATE INDEX `DeploymentRouteSet_tenant_target_scope_idx` ON `DeploymentRouteSet` (`tenantId`,`targetKind`,`targetIdentity`,`routeScopeKey`);--> statement-breakpoint
CREATE INDEX `DeploymentRoute_set_state_idx` ON `DeploymentRoute` (`routeSetId`,`routeState`);--> statement-breakpoint
CREATE INDEX `DeploymentRoute_agentRevision_idx` ON `DeploymentRoute` (`agentRevisionId`);--> statement-breakpoint
CREATE INDEX `DeploymentRoute_runtimeRevision_idx` ON `DeploymentRoute` (`runtimeRevisionId`);--> statement-breakpoint
CREATE INDEX `DeploymentRoute_activeRouteRevision_idx` ON `DeploymentRoute` (`activeRouteRevisionId`);--> statement-breakpoint
CREATE INDEX `Device_tenant_user_idx` ON `Device` (`tenantId`,`userId`);--> statement-breakpoint
CREATE INDEX `Device_tenant_state_idx` ON `Device` (`tenantId`,`deviceState`);--> statement-breakpoint
CREATE INDEX `EffectRecord_tenant_toolCall_idx` ON `EffectRecord` (`tenantId`,`toolCallId`);--> statement-breakpoint
CREATE INDEX `EffectRecord_tenant_state_idx` ON `EffectRecord` (`tenantId`,`effectState`);--> statement-breakpoint
CREATE INDEX `EffectTarget_tenant_record_idx` ON `EffectTarget` (`tenantId`,`effectRecordId`);--> statement-breakpoint
CREATE INDEX `EffectTarget_tenant_state_idx` ON `EffectTarget` (`tenantId`,`targetState`);--> statement-breakpoint
CREATE INDEX `EnvironmentChangeRequest_tenant_thread_state_idx` ON `EnvironmentChangeRequest` (`tenantId`,`threadId`,`requestState`);--> statement-breakpoint
CREATE INDEX `EnvironmentChangeRequest_tenant_invocation_idx` ON `EnvironmentChangeRequest` (`tenantId`,`invocationId`);--> statement-breakpoint
CREATE INDEX `EnvironmentChangeRequest_from_definition_idx` ON `EnvironmentChangeRequest` (`fromEnvironmentDefinitionId`);--> statement-breakpoint
CREATE INDEX `EnvironmentChangeRequest_requested_definition_idx` ON `EnvironmentChangeRequest` (`requestedEnvironmentDefinitionId`);--> statement-breakpoint
CREATE INDEX `EnvironmentDefinition_tenant_lifecycle_updated_idx` ON `EnvironmentDefinition` (`tenantId`,`lifecycleState`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `EnvironmentDefinition_tenant_type_idx` ON `EnvironmentDefinition` (`tenantId`,`environmentType`);--> statement-breakpoint
CREATE INDEX `EnvironmentLease_tenant_state_idx` ON `EnvironmentLease` (`tenantId`,`leaseState`);--> statement-breakpoint
CREATE INDEX `EnvironmentLease_definition_idx` ON `EnvironmentLease` (`environmentDefinitionId`);--> statement-breakpoint
CREATE INDEX `EnvironmentLease_device_idx` ON `EnvironmentLease` (`deviceId`);--> statement-breakpoint
CREATE INDEX `tenant_run_idx` ON `evaluation_case` (`tenant_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `tenant_case_state_idx` ON `evaluation_case` (`tenant_id`,`case_state`);--> statement-breakpoint
CREATE INDEX `tenant_run_idx` ON `evaluation_result` (`tenant_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `tenant_case_idx` ON `evaluation_result` (`tenant_id`,`case_id`);--> statement-breakpoint
CREATE INDEX `tenant_metric_idx` ON `evaluation_result` (`tenant_id`,`metric_key`);--> statement-breakpoint
CREATE INDEX `tenant_state_idx` ON `evaluation_run` (`tenant_id`,`run_state`);--> statement-breakpoint
CREATE INDEX `tenant_job_idx` ON `evaluation_run` (`tenant_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `tenant_agent_revision_idx` ON `evaluation_run` (`tenant_id`,`agent_revision_id`);--> statement-breakpoint
CREATE INDEX `FileChange_tenant_toolCall_idx` ON `FileChange` (`tenantId`,`toolCallId`);--> statement-breakpoint
CREATE INDEX `FileChange_tenant_binding_idx` ON `FileChange` (`tenantId`,`workspaceBindingId`);--> statement-breakpoint
CREATE INDEX `FileChange_tenant_artifact_idx` ON `FileChange` (`tenantId`,`artifactId`);--> statement-breakpoint
CREATE INDEX `FilesystemCheckpoint_tenant_binding_idx` ON `FilesystemCheckpoint` (`tenantId`,`workspaceBindingId`);--> statement-breakpoint
CREATE INDEX `FilesystemCheckpoint_tenant_invocation_idx` ON `FilesystemCheckpoint` (`tenantId`,`invocationId`);--> statement-breakpoint
CREATE INDEX `FilesystemCheckpoint_tenant_expires_idx` ON `FilesystemCheckpoint` (`tenantId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `GovernanceConfigRevision_set_state_idx` ON `GovernanceConfigRevision` (`configSetId`,`revisionState`);--> statement-breakpoint
CREATE INDEX `GovernanceConfigSet_tenant_lifecycle_updated_idx` ON `GovernanceConfigSet` (`tenantId`,`lifecycleState`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `IdempotencyRecord_tenant_expires_idx` ON `IdempotencyRecord` (`tenantId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `PrincipalBinding_tenant_user_idx` ON `PrincipalBinding` (`tenantId`,`userIdentityId`);--> statement-breakpoint
CREATE INDEX `UserIdentity_tenant_email_idx` ON `UserIdentity` (`tenantId`,`email`);--> statement-breakpoint
CREATE INDEX `JobCommand_tenant_job_state_idx` ON `JobCommand` (`tenantId`,`jobId`,`commandState`);--> statement-breakpoint
CREATE INDEX `JobCommand_tenant_replacement_idx` ON `JobCommand` (`tenantId`,`replacementJobId`);--> statement-breakpoint
CREATE INDEX `JobEvent_tenant_job_idx` ON `JobEvent` (`tenantId`,`jobId`);--> statement-breakpoint
CREATE INDEX `JobEvent_tenant_job_invocation_idx` ON `JobEvent` (`tenantId`,`jobId`,`invocationId`);--> statement-breakpoint
CREATE INDEX `JobEvent_tenant_job_occurred_idx` ON `JobEvent` (`tenantId`,`jobId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `JobResultProjection_tenant_job_idx` ON `JobResultProjection` (`tenantId`,`jobId`);--> statement-breakpoint
CREATE INDEX `JobResultProjection_tenant_source_turn_idx` ON `JobResultProjection` (`tenantId`,`sourceTurnId`);--> statement-breakpoint
CREATE INDEX `Job_tenant_agent_idx` ON `Job` (`tenantId`,`agentId`);--> statement-breakpoint
CREATE INDEX `Job_tenant_state_idx` ON `Job` (`tenantId`,`jobState`);--> statement-breakpoint
CREATE INDEX `Job_tenant_thread_idx` ON `Job` (`tenantId`,`threadId`);--> statement-breakpoint
CREATE INDEX `Job_tenant_replaces_idx` ON `Job` (`tenantId`,`replacesJobId`);--> statement-breakpoint
CREATE INDEX `Job_tenant_type_state_idx` ON `Job` (`tenantId`,`jobType`,`jobState`);--> statement-breakpoint
CREATE INDEX `KnowledgeBase_tenant_lifecycle_idx` ON `KnowledgeBase` (`tenantId`,`lifecycleState`);--> statement-breakpoint
CREATE INDEX `KnowledgeBase_tenant_owner_idx` ON `KnowledgeBase` (`tenantId`,`ownerUserId`);--> statement-breakpoint
CREATE INDEX `KnowledgeChunk_tenant_revision_idx` ON `KnowledgeChunk` (`tenantId`,`documentRevisionId`);--> statement-breakpoint
CREATE INDEX `KnowledgeDocument_tenant_base_idx` ON `KnowledgeDocument` (`tenantId`,`knowledgeBaseId`);--> statement-breakpoint
CREATE INDEX `KnowledgeDocument_tenant_lifecycle_idx` ON `KnowledgeDocument` (`tenantId`,`lifecycleState`);--> statement-breakpoint
CREATE INDEX `KnowledgeDocumentRevision_tenant_doc_idx` ON `KnowledgeDocumentRevision` (`tenantId`,`documentId`);--> statement-breakpoint
CREATE INDEX `KnowledgeDocumentRevision_tenant_state_idx` ON `KnowledgeDocumentRevision` (`tenantId`,`revisionState`);--> statement-breakpoint
CREATE INDEX `KnowledgeIndex_tenant_provider_idx` ON `KnowledgeIndex` (`tenantId`,`indexProvider`);--> statement-breakpoint
CREATE INDEX `MemoryCandidate_tenant_invocation_idx` ON `MemoryCandidate` (`tenantId`,`invocationId`);--> statement-breakpoint
CREATE INDEX `MemoryCandidate_tenant_state_proposed_idx` ON `MemoryCandidate` (`tenantId`,`candidateState`,`proposedAt`);--> statement-breakpoint
CREATE INDEX `MemoryCandidate_tenant_scope_idx` ON `MemoryCandidate` (`tenantId`,`proposedScopeType`,`proposedScopeRef`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_tenant_scope_idx` ON `MemoryEntry` (`tenantId`,`scopeType`,`scopeRef`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_tenant_state_updated_idx` ON `MemoryEntry` (`tenantId`,`memoryState`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `MemoryEntry_tenant_contentHash_idx` ON `MemoryEntry` (`tenantId`,`contentHash`);--> statement-breakpoint
CREATE INDEX `MemorySource_candidate_idx` ON `MemorySource` (`memoryCandidateId`);--> statement-breakpoint
CREATE INDEX `Grant_tenant_user_state_idx` ON `Grant` (`tenantId`,`userId`,`grantState`);--> statement-breakpoint
CREATE INDEX `Grant_tenant_credential_idx` ON `Grant` (`tenantId`,`credentialRefId`);--> statement-breakpoint
CREATE INDEX `Grant_tenant_state_expires_idx` ON `Grant` (`tenantId`,`grantState`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `PermissionDecision_tenant_toolCall_idx` ON `PermissionDecision` (`tenantId`,`toolCallId`);--> statement-breakpoint
CREATE INDEX `PermissionDecision_tenant_decision_idx` ON `PermissionDecision` (`tenantId`,`decision`);--> statement-breakpoint
CREATE INDEX `PolicyRevision_set_state_idx` ON `PolicyRevision` (`policySetId`,`revisionState`);--> statement-breakpoint
CREATE INDEX `PolicySet_tenant_lifecycle_updated_idx` ON `PolicySet` (`tenantId`,`lifecycleState`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `Policy_tenant_set_idx` ON `Policy` (`tenantId`,`policySetId`);--> statement-breakpoint
CREATE INDEX `Policy_tenant_decision_idx` ON `Policy` (`tenantId`,`decision`);--> statement-breakpoint
CREATE INDEX `EventDeliveryFailure_consumer_stream_sequence_idx` ON `EventDeliveryFailure` (`consumerName`,`streamType`,`streamId`,`eventSequence`);--> statement-breakpoint
CREATE INDEX `EventDeliveryFailure_state_retry_idx` ON `EventDeliveryFailure` (`failureState`,`nextRetryAt`);--> statement-breakpoint
CREATE INDEX `EventStreamFloor_tenant_idx` ON `EventStreamFloor` (`tenantId`);--> statement-breakpoint
CREATE INDEX `ThreadListProjection_tenant_owner_activity_idx` ON `ThreadListProjection` (`tenantId`,`ownerUserId`,`lastActivityAt`);--> statement-breakpoint
CREATE INDEX `ThreadListProjection_tenant_lifecycle_idx` ON `ThreadListProjection` (`tenantId`,`lifecycleState`);--> statement-breakpoint
CREATE INDEX `TurnTimelineProjection_tenant_thread_sequence_idx` ON `TurnTimelineProjection` (`tenantId`,`threadId`,`turnSequence`);--> statement-breakpoint
CREATE INDEX `TurnTimelineProjection_thread_state_idx` ON `TurnTimelineProjection` (`threadId`,`turnState`);--> statement-breakpoint
CREATE INDEX `RecoveryDrillCheck_tenant_drill_idx` ON `RecoveryDrillCheck` (`tenantId`,`drillId`);--> statement-breakpoint
CREATE INDEX `RecoveryDrillCheck_drill_state_idx` ON `RecoveryDrillCheck` (`drillId`,`checkState`);--> statement-breakpoint
CREATE INDEX `RecoveryDrill_tenant_scheduled_idx` ON `RecoveryDrill` (`tenantId`,`scheduledAt`);--> statement-breakpoint
CREATE INDEX `RecoveryDrill_tenant_state_idx` ON `RecoveryDrill` (`tenantId`,`drillState`);--> statement-breakpoint
CREATE INDEX `RecoveryDrill_tenant_type_idx` ON `RecoveryDrill` (`tenantId`,`drillType`);--> statement-breakpoint
CREATE INDEX `RecoveryDrill_tenant_executed_by_idx` ON `RecoveryDrill` (`tenantId`,`executedBy`);--> statement-breakpoint
CREATE INDEX `LegalHold_tenant_state_idx` ON `LegalHold` (`tenantId`,`holdState`);--> statement-breakpoint
CREATE INDEX `LegalHold_valid_until_idx` ON `LegalHold` (`validUntil`);--> statement-breakpoint
CREATE INDEX `RetentionPolicy_tenant_data_class_idx` ON `RetentionPolicy` (`tenantId`,`dataClass`);--> statement-breakpoint
CREATE INDEX `RuntimeRevision_runtime_state_idx` ON `RuntimeRevision` (`runtimeId`,`revisionState`);--> statement-breakpoint
CREATE INDEX `RuntimeRevision_artifact_idx` ON `RuntimeRevision` (`artifactId`);--> statement-breakpoint
CREATE INDEX `Runtime_tenant_lifecycle_updated_idx` ON `Runtime` (`tenantId`,`lifecycleState`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `ExecutionBinding_tenant_idx` ON `ExecutionBinding` (`tenantId`);--> statement-breakpoint
CREATE INDEX `ExecutionBinding_runtimeRevision_idx` ON `ExecutionBinding` (`runtimeRevisionId`);--> statement-breakpoint
CREATE INDEX `ExecutionBinding_routeRevision_idx` ON `ExecutionBinding` (`routeRevisionId`);--> statement-breakpoint
CREATE INDEX `ExecutionBinding_runtimeArtifact_idx` ON `ExecutionBinding` (`runtimeArtifactId`);--> statement-breakpoint
CREATE INDEX `ExecutionBinding_conformanceRun_idx` ON `ExecutionBinding` (`conformanceRunId`);--> statement-breakpoint
CREATE INDEX `ExecutionOwnership_invocation_state_idx` ON `ExecutionOwnership` (`invocationId`,`ownershipState`);--> statement-breakpoint
CREATE INDEX `InvocationAttempt_invocation_state_idx` ON `InvocationAttempt` (`invocationId`,`attemptState`);--> statement-breakpoint
CREATE INDEX `InvocationAttempt_dispatch_retry_idx` ON `InvocationAttempt` (`attemptState`,`nextDispatchAt`);--> statement-breakpoint
CREATE INDEX `InvocationAttempt_dispatch_lease_idx` ON `InvocationAttempt` (`dispatchLeaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `Invocation_tenant_state_idx` ON `Invocation` (`tenantId`,`executionState`);--> statement-breakpoint
CREATE INDEX `Invocation_turn_idx` ON `Invocation` (`turnId`);--> statement-breakpoint
CREATE INDEX `RuntimeEventIngress_invocation_state_idx` ON `RuntimeEventIngress` (`invocationId`,`ingressState`);--> statement-breakpoint
CREATE INDEX `RuntimeSessionBinding_thread_idx` ON `RuntimeSessionBinding` (`threadId`);--> statement-breakpoint
CREATE INDEX `RuntimeSessionBinding_job_idx` ON `RuntimeSessionBinding` (`jobId`);--> statement-breakpoint
CREATE INDEX `IncidentContainment_tenant_incident_idx` ON `IncidentContainment` (`tenantId`,`incidentId`);--> statement-breakpoint
CREATE INDEX `IncidentContainment_incident_state_idx` ON `IncidentContainment` (`incidentId`,`actionState`);--> statement-breakpoint
CREATE INDEX `SecurityIncident_tenant_state_idx` ON `SecurityIncident` (`tenantId`,`incidentState`);--> statement-breakpoint
CREATE INDEX `SecurityIncident_tenant_target_idx` ON `SecurityIncident` (`tenantId`,`targetType`,`targetId`);--> statement-breakpoint
CREATE INDEX `SecurityIncident_tenant_severity_idx` ON `SecurityIncident` (`tenantId`,`severity`);--> statement-breakpoint
CREATE INDEX `SecurityIncident_tenant_detected_idx` ON `SecurityIncident` (`tenantId`,`detectedAt`);--> statement-breakpoint
CREATE INDEX `Skill_tenant_lifecycle_updated_idx` ON `Skill` (`tenantId`,`lifecycleState`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `SkillVersion_skill_state_idx` ON `SkillVersion` (`skillId`,`revisionState`);--> statement-breakpoint
CREATE INDEX `SkillSyncBinding_tenant_localSkill_idx` ON `SkillSyncBinding` (`tenantId`,`localSkillId`);--> statement-breakpoint
CREATE INDEX `SkillSyncBinding_tenant_syncState_idx` ON `SkillSyncBinding` (`tenantId`,`syncState`);--> statement-breakpoint
CREATE INDEX `CapabilityReview_tenant_state_created_idx` ON `CapabilityReview` (`tenantId`,`reviewState`,`createdAt`);--> statement-breakpoint
CREATE INDEX `CapabilityReview_tenant_resource_idx` ON `CapabilityReview` (`tenantId`,`resourceType`,`resourceId`);--> statement-breakpoint
CREATE INDEX `ToolCall_tenant_invocation_idx` ON `ToolCall` (`tenantId`,`invocationId`);--> statement-breakpoint
CREATE INDEX `ToolCall_tenant_tool_state_idx` ON `ToolCall` (`tenantId`,`toolId`,`callState`);--> statement-breakpoint
CREATE INDEX `Connection_tenant_lifecycle_updated_idx` ON `Connection` (`tenantId`,`lifecycleState`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `CredentialRef_tenant_connectionId_idx` ON `CredentialRef` (`tenantId`,`connectionId`);--> statement-breakpoint
CREATE INDEX `CredentialRef_tenant_fingerprint_idx` ON `CredentialRef` (`tenantId`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `ToolProvider_tenant_providerType_lifecycle_idx` ON `ToolProvider` (`tenantId`,`providerType`,`lifecycleState`);--> statement-breakpoint
CREATE INDEX `ToolSchemaRevision_tool_state_idx` ON `ToolSchemaRevision` (`toolId`,`revisionState`);--> statement-breakpoint
CREATE INDEX `Tool_tenant_lifecycle_riskClass_idx` ON `Tool` (`tenantId`,`lifecycleState`,`riskClass`);--> statement-breakpoint
CREATE INDEX `tenant_trace_idx` ON `observation` (`tenant_id`,`trace_id`);--> statement-breakpoint
CREATE INDEX `tenant_span_idx` ON `observation` (`tenant_id`,`span_id`);--> statement-breakpoint
CREATE INDEX `tenant_invocation_idx` ON `observation` (`tenant_id`,`invocation_id`);--> statement-breakpoint
CREATE INDEX `tenant_kind_idx` ON `observation` (`tenant_id`,`kind`);--> statement-breakpoint
CREATE INDEX `tenant_trace_idx` ON `span` (`tenant_id`,`trace_id`);--> statement-breakpoint
CREATE INDEX `tenant_parent_idx` ON `span` (`tenant_id`,`parent_span_id`);--> statement-breakpoint
CREATE INDEX `tenant_kind_idx` ON `span` (`tenant_id`,`kind`);--> statement-breakpoint
CREATE INDEX `tenant_root_idx` ON `trace` (`tenant_id`,`root_type`,`root_id`);--> statement-breakpoint
CREATE INDEX `tenant_trace_key_idx` ON `trace` (`tenant_id`,`trace_key`);--> statement-breakpoint
CREATE INDEX `tenant_state_idx` ON `trace` (`tenant_id`,`trace_state`);--> statement-breakpoint
CREATE INDEX `tenant_scope_snapshot_idx` ON `capacity_snapshot` (`tenant_id`,`scope_type`,`scope_ref`,`snapshot_at`);--> statement-breakpoint
CREATE INDEX `tenant_dim_scope_window_idx` ON `cost_aggregate` (`tenant_id`,`dimension`,`scope_type`,`window_start`,`granularity`);--> statement-breakpoint
CREATE INDEX `tenant_scope_key_measured_idx` ON `service_level_indicator` (`tenant_id`,`scope_type`,`indicator_key`,`measured_at`);--> statement-breakpoint
CREATE INDEX `tenant_breach_idx` ON `service_level_indicator` (`tenant_id`,`breach`);--> statement-breakpoint
CREATE INDEX `tenant_error_code_idx` ON `service_level_indicator` (`tenant_id`,`error_code`);--> statement-breakpoint
CREATE INDEX `tenant_dim_scope_idx` ON `usage_record` (`tenant_id`,`dimension`,`scope_type`);--> statement-breakpoint
CREATE INDEX `tenant_observed_idx` ON `usage_record` (`tenant_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `tenant_invocation_idx` ON `usage_record` (`tenant_id`,`invocation_id`);--> statement-breakpoint
CREATE INDEX `tenant_job_idx` ON `usage_record` (`tenant_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `tenant_agent_revision_idx` ON `usage_record` (`tenant_id`,`agent_revision_id`);--> statement-breakpoint
CREATE INDEX `UserActionRequest_tenant_invocation_state_idx` ON `UserActionRequest` (`tenantId`,`invocationId`,`requestState`);--> statement-breakpoint
CREATE INDEX `UserActionRequest_tenant_toolCall_idx` ON `UserActionRequest` (`tenantId`,`toolCallId`);--> statement-breakpoint
CREATE INDEX `UserActionRequest_tenant_state_expires_idx` ON `UserActionRequest` (`tenantId`,`requestState`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `UserActionRequest_auth_state_hash_idx` ON `UserActionRequest` (`authStateHash`);--> statement-breakpoint
CREATE INDEX `WorkloadTokenRevocation_tenant_revoked_idx` ON `WorkloadTokenRevocation` (`tenantId`,`revokedAt`);--> statement-breakpoint
CREATE INDEX `WorkloadTokenRevocation_expires_idx` ON `WorkloadTokenRevocation` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `WorkspaceMergeConflict_tenant_overlay_idx` ON `WorkspaceMergeConflict` (`tenantId`,`overlayId`);--> statement-breakpoint
CREATE INDEX `WorkspaceMergeConflict_tenant_state_idx` ON `WorkspaceMergeConflict` (`tenantId`,`conflictState`);--> statement-breakpoint
CREATE INDEX `WorkspaceOverlay_tenant_state_idx` ON `WorkspaceOverlay` (`tenantId`,`overlayState`);--> statement-breakpoint
CREATE INDEX `WorkspaceOverlay_tenant_relation_idx` ON `WorkspaceOverlay` (`tenantId`,`relationId`);--> statement-breakpoint
CREATE INDEX `WorkspaceWriteLock_tenant_holder_idx` ON `WorkspaceWriteLock` (`tenantId`,`holderInvocationId`);--> statement-breakpoint
CREATE INDEX `WorkspaceWriteLock_tenant_state_idx` ON `WorkspaceWriteLock` (`tenantId`,`lockState`);--> statement-breakpoint
CREATE INDEX `WorkspaceWriteLock_tenant_expiry_idx` ON `WorkspaceWriteLock` (`tenantId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `Workspace_tenant_owner_idx` ON `Workspace` (`tenantId`,`ownerUserId`);--> statement-breakpoint
CREATE INDEX `Workspace_tenant_lifecycle_idx` ON `Workspace` (`tenantId`,`lifecycleState`);--> statement-breakpoint
CREATE INDEX `WorkspaceAttachment_tenant_thread_idx` ON `WorkspaceAttachment` (`tenantId`,`threadId`);--> statement-breakpoint
CREATE INDEX `WorkspaceAttachment_tenant_binding_idx` ON `WorkspaceAttachment` (`tenantId`,`workspaceBindingId`);--> statement-breakpoint
CREATE INDEX `WorkspaceAttachment_tenant_state_idx` ON `WorkspaceAttachment` (`tenantId`,`attachmentState`);--> statement-breakpoint
CREATE INDEX `WorkspaceAttachmentUse_tenant_turn_idx` ON `WorkspaceAttachmentUse` (`tenantId`,`turnId`);--> statement-breakpoint
CREATE INDEX `WorkspaceAttachmentUse_tenant_attachment_idx` ON `WorkspaceAttachmentUse` (`tenantId`,`workspaceAttachmentId`);--> statement-breakpoint
CREATE INDEX `WorkspaceBinding_tenant_workspace_idx` ON `WorkspaceBinding` (`tenantId`,`workspaceId`);--> statement-breakpoint
CREATE INDEX `WorkspaceBinding_tenant_device_idx` ON `WorkspaceBinding` (`tenantId`,`deviceId`);--> statement-breakpoint
CREATE INDEX `WorkspaceBinding_tenant_state_idx` ON `WorkspaceBinding` (`tenantId`,`bindingState`);--> statement-breakpoint
CREATE INDEX `ControlPlaneEventDelivery_claimable_idx` ON `ControlPlaneEventDelivery` (`state`,`consumerName`,`nextAttemptAt`,`lockExpiresAt`);--> statement-breakpoint
CREATE INDEX `ControlPlaneOutboxEvent_aggregate_idx` ON `ControlPlaneOutboxEvent` (`aggregateType`,`aggregateId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `Artifact_tenant_kind_created_idx` ON `Artifact` (`tenantId`,`kind`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ArtifactAttestation_artifact_idx` ON `ArtifactAttestation` (`artifactId`);--> statement-breakpoint
CREATE INDEX `ArtifactAttestation_tenant_type_rev_state_idx` ON `ArtifactAttestation` (`tenantId`,`artifactType`,`artifactRevisionId`,`verificationState`);--> statement-breakpoint
CREATE INDEX `ArtifactAttestation_tenant_digest_idx` ON `ArtifactAttestation` (`tenantId`,`artifactDigest`);--> statement-breakpoint
CREATE INDEX `AttestationRevocationRecord_tenant_revoked_idx` ON `AttestationRevocationRecord` (`tenantId`,`revokedAt`);--> statement-breakpoint
CREATE INDEX `PublicationRecord_tenant_published_idx` ON `PublicationRecord` (`tenantId`,`publishedAt`);--> statement-breakpoint
CREATE INDEX `WithdrawalRecord_tenant_withdrawn_idx` ON `WithdrawalRecord` (`tenantId`,`withdrawnAt`);--> statement-breakpoint
CREATE INDEX `RouteActivation_revision_activated_idx` ON `RouteActivation` (`routeRevisionId`,`activatedAt`);--> statement-breakpoint
CREATE INDEX `RouteActivation_routeSetId_routeSetVersionNo_idx` ON `RouteActivation` (`routeSetId`,`routeSetVersionNo`);--> statement-breakpoint
CREATE INDEX `RouteRevision_routeSet_idx` ON `RouteRevision` (`routeSetId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `RouteRevision_routeSetId_routeGroupId_priorityNo_idx` ON `RouteRevision` (`routeSetId`,`routeGroupId`,`priorityNo`);--> statement-breakpoint
CREATE INDEX `RouteRevision_routeSetId_selectorDigest_priorityNo_idx` ON `RouteRevision` (`routeSetId`,`selectorDigest`,`priorityNo`);--> statement-breakpoint
CREATE INDEX `RouteEligibilityProjection_tenant_agent_scope_idx` ON `RouteEligibilityProjection` (`tenantId`,`agentId`,`routeScopeKey`,`eligibilityState`);--> statement-breakpoint
CREATE INDEX `RouteEligibilityProjection_routeSet_version_idx` ON `RouteEligibilityProjection` (`routeSetId`,`routeSetVersionNo`);--> statement-breakpoint
CREATE INDEX `RouteEligibilityProjection_group_selector_priority_idx` ON `RouteEligibilityProjection` (`routeGroupId`,`selectorDigest`,`priorityNo`);--> statement-breakpoint
CREATE INDEX `RouteEligibilityProjection_tenant_idx` ON `RouteEligibilityProjection` (`tenantId`);--> statement-breakpoint
CREATE INDEX `RuntimeConformanceRun_revision_completed_idx` ON `RuntimeConformanceRun` (`runtimeRevisionId`,`completedAt`);--> statement-breakpoint
CREATE INDEX `HostedProvisioningRequest_tenantId_idx` ON `HostedProvisioningRequest` (`tenantId`);--> statement-breakpoint
CREATE INDEX `HostedProvisioningRequest_state_idx` ON `HostedProvisioningRequest` (`state`);--> statement-breakpoint
CREATE INDEX `HostedProvisioningRequest_claimable_idx` ON `HostedProvisioningRequest` (`state`,`nextAttemptAt`,`leaseExpiresAt`);--> statement-breakpoint
CREATE TRIGGER `RouteRevision_prevent_update` BEFORE UPDATE ON `RouteRevision` FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RouteRevision is append-only'; END;--> statement-breakpoint
CREATE TRIGGER `RouteActivation_prevent_update` BEFORE UPDATE ON `RouteActivation` FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RouteActivation is append-only'; END;
