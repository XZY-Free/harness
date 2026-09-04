ALTER TABLE `AgentCallEventIngress` RENAME COLUMN `rejectedReason` TO `reasonCode`;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` RENAME COLUMN `mappedAt` TO `processedAt`;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` DROP INDEX `AgentCallEventIngress_call_producer_event_uq`;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` MODIFY COLUMN `reasonCode` varchar(128);--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` MODIFY COLUMN `ingressState` enum('accepted','mapped','rejected','applied','idempotent','failed_retryable') NOT NULL;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` ADD `producerSource` varchar(192);--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` ADD `beforeVersionNo` bigint;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` ADD `afterVersionNo` bigint;--> statement-breakpoint
UPDATE `AgentCallEventIngress` AS ingress
INNER JOIN `AgentCall` AS call_row ON call_row.`id` = ingress.`callId`
INNER JOIN `AgentCallBinding` AS binding_row ON binding_row.`callId` = ingress.`callId`
SET ingress.`producerSource` = CONCAT(
    call_row.`agentId`, ':', binding_row.`protocolType`, ':', binding_row.`protocolContractRevision`
  ),
  ingress.`beforeVersionNo` = call_row.`versionNo`,
  ingress.`afterVersionNo` = call_row.`versionNo`,
  ingress.`processedAt` = COALESCE(ingress.`processedAt`, ingress.`receivedAt`),
  ingress.`ingressState` = CASE ingress.`ingressState`
    WHEN 'mapped' THEN 'applied'
    WHEN 'accepted' THEN 'failed_retryable'
    ELSE ingress.`ingressState`
  END;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` MODIFY COLUMN `ingressState` enum('applied','idempotent','rejected','failed_retryable') NOT NULL;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` MODIFY COLUMN `producerSource` varchar(192) NOT NULL;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` MODIFY COLUMN `beforeVersionNo` bigint NOT NULL;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` MODIFY COLUMN `afterVersionNo` bigint NOT NULL;--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` MODIFY COLUMN `processedAt` datetime(3) NOT NULL;--> statement-breakpoint
DROP TABLE IF EXISTS `_AgentCallIngressAuthorityMigrationGuard`;--> statement-breakpoint
CREATE TABLE `_AgentCallIngressAuthorityMigrationGuard` (
	`conflictCode` varchar(64) NOT NULL PRIMARY KEY,
	`mustPass` int NOT NULL,
	CONSTRAINT `_AgentCallIngressAuthorityMigrationGuard_no_conflicts` CHECK (`mustPass` = 1)
);--> statement-breakpoint
INSERT INTO `_AgentCallIngressAuthorityMigrationGuard` (`conflictCode`, `mustPass`)
SELECT 'duplicate_supplier_event', 0
WHERE EXISTS (
	SELECT `tenantId`, `producerSource`, `producerEventId`
	FROM `AgentCallEventIngress`
	GROUP BY `tenantId`, `producerSource`, `producerEventId`
	HAVING COUNT(*) > 1
);--> statement-breakpoint
ALTER TABLE `AgentCallEventIngress` ADD CONSTRAINT `AgentCallEventIngress_producer_event_uq` UNIQUE(`tenantId`,`producerSource`,`producerEventId`);--> statement-breakpoint
DROP TABLE `_AgentCallIngressAuthorityMigrationGuard`;
