ALTER TABLE `PublicationRecord` ADD `agentDescriptorSnapshotId` varchar(36);--> statement-breakpoint
ALTER TABLE `PublicationRecord` ADD `agentProviderDescriptorDigest` varchar(71);--> statement-breakpoint
ALTER TABLE `PublicationRecord` ADD `agentCapabilityManifestDigest` varchar(71);--> statement-breakpoint
ALTER TABLE `PublicationRecord` ADD `agentInvocationContextContractDigest` varchar(71);