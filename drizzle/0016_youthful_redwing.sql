ALTER TABLE `ExecutionBinding` DROP CONSTRAINT `ExecutionBinding_agentEvidence_all_or_nothing`;--> statement-breakpoint
DROP INDEX `AgentRevision_artifact_idx` ON `AgentRevision`;--> statement-breakpoint
DROP INDEX `ExecutionBinding_agentArtifact_idx` ON `ExecutionBinding`;--> statement-breakpoint
ALTER TABLE `AgentRevision` MODIFY COLUMN `agentContractSnapshotId` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD CONSTRAINT `ExecutionBinding_agentEvidence_all_or_nothing` CHECK ((
        `ExecutionBinding`.`agentRevisionId` IS NULL
        AND `ExecutionBinding`.`agentContractSnapshotId` IS NULL
        AND `ExecutionBinding`.`agentContractDigest` IS NULL
        AND `ExecutionBinding`.`agentContextDigest` IS NULL
        AND `ExecutionBinding`.`agentPublicationRecordId` IS NULL
      ) OR (
        `ExecutionBinding`.`agentRevisionId` IS NOT NULL
        AND `ExecutionBinding`.`agentContractSnapshotId` IS NOT NULL
        AND `ExecutionBinding`.`agentContractDigest` IS NOT NULL
        AND `ExecutionBinding`.`agentContextDigest` IS NOT NULL
        AND `ExecutionBinding`.`agentPublicationRecordId` IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE `AgentRevision` DROP COLUMN `sourceType`;--> statement-breakpoint
ALTER TABLE `AgentRevision` DROP COLUMN `sourceRevision`;--> statement-breakpoint
ALTER TABLE `AgentRevision` DROP COLUMN `instructionHash`;--> statement-breakpoint
ALTER TABLE `AgentRevision` DROP COLUMN `agentArtifactRef`;--> statement-breakpoint
ALTER TABLE `AgentRevision` DROP COLUMN `artifactId`;--> statement-breakpoint
ALTER TABLE `AgentRevision` DROP COLUMN `artifactDigest`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` DROP COLUMN `agentArtifactId`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` DROP COLUMN `agentArtifactDigest`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` DROP COLUMN `agentAttestationIds`;--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` DROP COLUMN `agentAttestationIds`;--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` DROP COLUMN `agentArtifactId`;--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` DROP COLUMN `agentArtifactDigest`;--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` DROP COLUMN `stepAgentAttestationId`;