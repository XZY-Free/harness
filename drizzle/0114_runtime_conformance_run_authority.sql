ALTER TABLE `V11RuntimeRevision`
  ADD COLUMN `protocolContractRevision` varchar(128) NOT NULL DEFAULT 'agent-runtime-protocol@1' AFTER `protocolType`;
--> statement-breakpoint
UPDATE `V11RuntimeRevision`
SET `protocolContractRevision` = CASE
  WHEN `protocolType` = 'a2a' THEN 'a2a@1'
  ELSE 'agent-runtime-protocol@1'
END;
--> statement-breakpoint
CREATE TABLE `RuntimeConformanceRun` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `runtimeRevisionId` varchar(36) NOT NULL,
  `runtimeArtifactDigest` varchar(71) NOT NULL,
  `runtimeConfigDigest` varchar(71) NOT NULL,
  `protocolContractRevision` varchar(128) NOT NULL,
  `suiteRevision` varchar(128) NOT NULL,
  `runnerArtifactDigest` varchar(71) NOT NULL,
  `runnerIdentity` varchar(255) NOT NULL,
  `testEnvironmentRevision` varchar(128) NOT NULL,
  `startedAt` datetime(3) NOT NULL,
  `completedAt` datetime(3) NOT NULL,
  `overallResult` enum('passed','failed','error','cancelled') NOT NULL,
  `evidenceManifestDigest` varchar(71) NOT NULL,
  `runnerSignature` varchar(64) NOT NULL,
  `idempotencyKey` varchar(255) NOT NULL,
  `requestId` varchar(64) NOT NULL,
  `recordedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `RuntimeConformanceRun_idempotency_uq` (`tenantId`,`runtimeRevisionId`,`idempotencyKey`),
  UNIQUE KEY `RuntimeConformanceRun_evidence_uq` (`tenantId`,`evidenceManifestDigest`),
  KEY `RuntimeConformanceRun_revision_completed_idx` (`runtimeRevisionId`,`completedAt`),
  CONSTRAINT `RuntimeConformanceRun_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `RuntimeConformanceRun_runtimeRevisionId_fk` FOREIGN KEY (`runtimeRevisionId`) REFERENCES `V11RuntimeRevision` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE `RuntimeConformanceCaseResult` (
  `id` varchar(36) NOT NULL,
  `runId` varchar(36) NOT NULL,
  `caseId` varchar(128) NOT NULL,
  `passed` boolean NOT NULL,
  `reason` text NULL,
  `evidenceDigest` varchar(71) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `RuntimeConformanceCaseResult_run_case_uq` (`runId`,`caseId`),
  CONSTRAINT `RuntimeConformanceCaseResult_runId_fk` FOREIGN KEY (`runId`) REFERENCES `RuntimeConformanceRun` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
