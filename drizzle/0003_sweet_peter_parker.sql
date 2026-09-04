DROP TABLE IF EXISTS `_AgentCallAuthorityMigrationGuard`;--> statement-breakpoint
CREATE TABLE `_AgentCallAuthorityMigrationGuard` (
	`conflictCode` varchar(64) NOT NULL PRIMARY KEY,
	`mustPass` int NOT NULL,
	CONSTRAINT `_AgentCallAuthorityMigrationGuard_no_conflicts` CHECK (`mustPass` = 1)
);--> statement-breakpoint
INSERT INTO `_AgentCallAuthorityMigrationGuard` (`conflictCode`, `mustPass`)
SELECT 'missing_source_action', 0
WHERE EXISTS (
	SELECT 1 FROM `AgentCall`
	WHERE `sourceRef` IS NULL OR TRIM(`sourceRef`) = '' OR `sourceType` <> 'harness_planned'
);--> statement-breakpoint
INSERT INTO `_AgentCallAuthorityMigrationGuard` (`conflictCode`, `mustPass`)
SELECT 'missing_binding_or_attempt', 0
WHERE EXISTS (
	SELECT 1
	FROM `AgentCall` AS call_row
	LEFT JOIN `AgentCallBinding` AS binding_row ON binding_row.`callId` = call_row.`id`
	LEFT JOIN `AgentCallAttempt` AS attempt_row ON attempt_row.`callId` = call_row.`id`
	WHERE call_row.`state` IN ('queued', 'running', 'waiting_user')
		AND (binding_row.`callId` IS NULL OR attempt_row.`id` IS NULL)
);--> statement-breakpoint
INSERT INTO `_AgentCallAuthorityMigrationGuard` (`conflictCode`, `mustPass`)
SELECT 'duplicate_logical_semantics', 0
WHERE EXISTS (
	SELECT `tenantId`, `parentInvocationId`, `sourceRef`, `agentId`
	FROM `AgentCall`
	GROUP BY `tenantId`, `parentInvocationId`, `sourceRef`, `agentId`
	HAVING COUNT(*) > 1
);--> statement-breakpoint
INSERT INTO `_AgentCallAuthorityMigrationGuard` (`conflictCode`, `mustPass`)
SELECT 'ambiguous_task_attempt', 0
WHERE EXISTS (
	SELECT call_row.`id`
	FROM `AgentCall` AS call_row
	LEFT JOIN `AgentCallAttempt` AS attempt_row ON attempt_row.`callId` = call_row.`id`
	WHERE call_row.`externalTaskRef` IS NOT NULL
	GROUP BY call_row.`id`
	HAVING COUNT(attempt_row.`id`) <> 1
);--> statement-breakpoint
INSERT INTO `_AgentCallAuthorityMigrationGuard` (`conflictCode`, `mustPass`)
SELECT 'duplicate_task_mapping', 0
WHERE EXISTS (
	SELECT `tenantId`, `externalTaskRef`
	FROM `AgentCall`
	WHERE `externalTaskRef` IS NOT NULL
	GROUP BY `tenantId`, `externalTaskRef`
	HAVING COUNT(*) > 1
);--> statement-breakpoint
INSERT INTO `_AgentCallAuthorityMigrationGuard` (`conflictCode`, `mustPass`)
SELECT 'duplicate_context_mapping', 0
WHERE EXISTS (
	SELECT `tenantId`, `externalContextRef`
	FROM `AgentSessionBinding`
	GROUP BY `tenantId`, `externalContextRef`
	HAVING COUNT(*) > 1
);--> statement-breakpoint
INSERT INTO `_AgentCallAuthorityMigrationGuard` (`conflictCode`, `mustPass`)
SELECT 'attempt_sequence_conflict', 0
WHERE EXISTS (
	SELECT `callId`
	FROM `AgentCallAttempt`
	GROUP BY `callId`
	HAVING MIN(`attemptNo`) <> 1
		OR MAX(`attemptNo`) <> COUNT(*)
		OR COUNT(DISTINCT `attemptNo`) <> COUNT(*)
);--> statement-breakpoint
INSERT INTO `_AgentCallAuthorityMigrationGuard` (`conflictCode`, `mustPass`)
SELECT 'transport_channel_unresolved', 0
WHERE EXISTS (
	SELECT 1
	FROM `AgentCallAttempt` AS attempt_row
	INNER JOIN `AgentCall` AS call_row ON call_row.`id` = attempt_row.`callId`
	LEFT JOIN `ExecutionBinding` AS execution_binding
		ON execution_binding.`invocationId` = call_row.`parentInvocationId`
		AND execution_binding.`tenantId` = call_row.`tenantId`
	WHERE execution_binding.`invocationId` IS NULL
);--> statement-breakpoint
ALTER TABLE `AgentCallAttempt` ADD `externalTaskRef` varchar(256);--> statement-breakpoint
ALTER TABLE `AgentCallAttempt` ADD `transportChannel` enum('hosted','gateway');--> statement-breakpoint
ALTER TABLE `AgentCallAttempt` ADD `transportMetadataJson` json;--> statement-breakpoint
UPDATE `AgentCall`
SET `logicalCallKey` = CONCAT('harness-action:', TRIM(`sourceRef`), ':agent:', TRIM(`agentId`));--> statement-breakpoint
UPDATE `AgentCallAttempt` AS attempt_row
INNER JOIN `AgentCall` AS call_row ON call_row.`id` = attempt_row.`callId`
SET attempt_row.`externalTaskRef` = call_row.`externalTaskRef`
WHERE call_row.`externalTaskRef` IS NOT NULL;--> statement-breakpoint
UPDATE `AgentCallAttempt` AS attempt_row
INNER JOIN `AgentCall` AS call_row ON call_row.`id` = attempt_row.`callId`
INNER JOIN `ExecutionBinding` AS execution_binding
	ON execution_binding.`invocationId` = call_row.`parentInvocationId`
	AND execution_binding.`tenantId` = call_row.`tenantId`
SET attempt_row.`transportChannel` = CASE
		WHEN execution_binding.`runtimeEvidenceKind` = 'hosted_artifact' THEN 'hosted'
		ELSE 'gateway'
	END,
	attempt_row.`transportMetadataJson` = JSON_OBJECT(
		'channel', CASE
			WHEN execution_binding.`runtimeEvidenceKind` = 'hosted_artifact' THEN 'hosted'
			ELSE 'gateway'
		END,
		'migrated', TRUE
	);--> statement-breakpoint
ALTER TABLE `AgentCall` MODIFY COLUMN `logicalCallKey` varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE `AgentCall` MODIFY COLUMN `sourceRef` varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE `AgentCall` MODIFY COLUMN `sourceType` enum('harness_planned') NOT NULL;--> statement-breakpoint
ALTER TABLE `AgentCallAttempt` MODIFY COLUMN `transportChannel` enum('hosted','gateway') NOT NULL;--> statement-breakpoint
ALTER TABLE `AgentCallAttempt` ADD CONSTRAINT `AgentCallAttempt_tenant_task_uq` UNIQUE(`tenantId`,`externalTaskRef`);--> statement-breakpoint
ALTER TABLE `AgentSessionBinding` ADD CONSTRAINT `AgentSessionBinding_tenant_context_uq` UNIQUE(`tenantId`,`externalContextRef`);--> statement-breakpoint
ALTER TABLE `AgentSessionBinding` DROP INDEX `AgentSessionBinding_revision_route_context_uq`;--> statement-breakpoint
ALTER TABLE `AgentCall` DROP COLUMN `externalTaskRef`;--> statement-breakpoint
DROP TABLE `_AgentCallAuthorityMigrationGuard`;
