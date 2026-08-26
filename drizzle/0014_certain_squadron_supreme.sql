DROP TABLE `AgentDescriptorSnapshot`;--> statement-breakpoint
ALTER TABLE `AgentRevision` RENAME COLUMN `agentDescriptorSnapshotId` TO `agentContractSnapshotId`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` RENAME COLUMN `agentDescriptorSnapshotId` TO `agentContractSnapshotId`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` RENAME COLUMN `agentProviderDescriptorDigest` TO `agentContractDigest`;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` RENAME COLUMN `agentInvocationContextContractDigest` TO `agentContextDigest`;--> statement-breakpoint
ALTER TABLE `PublicationRecord` RENAME COLUMN `agentDescriptorSnapshotId` TO `agentContractSnapshotId`;--> statement-breakpoint
ALTER TABLE `PublicationRecord` RENAME COLUMN `agentProviderDescriptorDigest` TO `agentContractDigest`;--> statement-breakpoint
ALTER TABLE `PublicationRecord` RENAME COLUMN `agentCapabilityManifestDigest` TO `agentCapabilityDigest`;--> statement-breakpoint
ALTER TABLE `PublicationRecord` RENAME COLUMN `agentInvocationContextContractDigest` TO `agentContextDigest`;--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` RENAME COLUMN `agentDescriptorSnapshotId` TO `agentContractSnapshotId`;--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` RENAME COLUMN `agentProviderDescriptorDigest` TO `agentContractDigest`;--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` RENAME COLUMN `agentInvocationContextContractDigest` TO `agentContextDigest`;