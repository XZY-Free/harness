ALTER TABLE `RuntimeConformanceRun` RENAME COLUMN `runtimeArtifactDigest` TO `runtimeTargetDigest`;--> statement-breakpoint
ALTER TABLE `RuntimeRevision` MODIFY COLUMN `protocolContractRevision` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `RuntimeRevision` MODIFY COLUMN `runtimeArtifactRef` varchar(512);--> statement-breakpoint
ALTER TABLE `RuntimeRevision` ADD `runtimeEvidenceKind` enum('hosted_artifact','external_endpoint') NOT NULL DEFAULT 'hosted_artifact';--> statement-breakpoint
ALTER TABLE `RuntimeRevision` ADD `runtimeTargetDigest` varchar(71) NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `RuntimeRevision` rr JOIN `Runtime` r ON r.id = rr.runtimeId SET rr.`runtimeEvidenceKind` = CASE WHEN r.`runtimeKind` = 'external' THEN 'external_endpoint' ELSE 'hosted_artifact' END;