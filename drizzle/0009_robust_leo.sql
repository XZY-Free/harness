ALTER TABLE `ExecutionBinding` MODIFY COLUMN `runtimeArtifactId` varchar(36);--> statement-breakpoint
ALTER TABLE `ExecutionBinding` MODIFY COLUMN `runtimeArtifactDigest` varchar(71);--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `runtimeEvidenceKind` enum('hosted_artifact','external_endpoint') NOT NULL DEFAULT 'hosted_artifact';--> statement-breakpoint
UPDATE `ExecutionBinding` eb JOIN `RuntimeRevision` rr ON rr.id = eb.runtimeRevisionId SET eb.`runtimeEvidenceKind` = rr.`runtimeEvidenceKind`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `agentDescriptorSnapshotId` varchar(36);--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `agentProviderDescriptorDigest` varchar(71);--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `agentInvocationContextContractDigest` varchar(71);--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `runtimeEvidenceKind` enum('hosted_artifact','external_endpoint') NOT NULL DEFAULT 'hosted_artifact';--> statement-breakpoint
UPDATE `RouteEligibilityProjection` p JOIN `RuntimeRevision` rr ON rr.id = p.runtimeRevisionId SET p.`runtimeEvidenceKind` = rr.`runtimeEvidenceKind`;--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `agentDescriptorSnapshotId` varchar(36);--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `agentProviderDescriptorDigest` varchar(71);--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `agentInvocationContextContractDigest` varchar(71);