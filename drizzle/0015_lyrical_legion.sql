ALTER TABLE `RuntimeRevision` ADD `agentContractSnapshotId` varchar(36);--> statement-breakpoint
ALTER TABLE `RuntimeRevision` ADD `credentialRefId` varchar(36);--> statement-breakpoint
ALTER TABLE `RuntimeRevision` ADD `verificationState` varchar(32);--> statement-breakpoint
ALTER TABLE `RuntimeRevision` ADD `evidenceDigest` varchar(71);--> statement-breakpoint
ALTER TABLE `RuntimeRevision` ADD `verifiedAt` datetime(3);