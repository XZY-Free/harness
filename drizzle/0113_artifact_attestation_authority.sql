CREATE TABLE `Artifact` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `kind` varchar(64) NOT NULL,
  `digest` varchar(71) NOT NULL,
  `mediaType` varchar(255) NULL,
  `size` bigint unsigned NULL,
  `contentRef` varchar(512) NULL,
  `sourceRevision` varchar(128) NULL,
  `buildMetadata` json NULL,
  `createdAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `Artifact_tenant_digest_uq` (`tenantId`, `digest`),
  KEY `Artifact_tenant_kind_created_idx` (`tenantId`, `kind`, `createdAt`),
  CONSTRAINT `Artifact_tenantId_fk`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
ALTER TABLE `V11ArtifactAttestation`
  ADD COLUMN `artifactId` varchar(36) NULL AFTER `tenantId`,
  ADD KEY `V11ArtifactAttestation_artifact_idx` (`artifactId`),
  ADD CONSTRAINT `V11ArtifactAttestation_artifactId_fk`
    FOREIGN KEY (`artifactId`) REFERENCES `Artifact` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
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
  PRIMARY KEY (`id`),
  UNIQUE KEY `AttestationRevocationRecord_attestation_uq` (`attestationId`),
  KEY `AttestationRevocationRecord_tenant_revoked_idx` (`tenantId`, `revokedAt`),
  CONSTRAINT `AttestationRevocationRecord_tenantId_fk`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `AttestationRevocationRecord_attestationId_fk`
    FOREIGN KEY (`attestationId`) REFERENCES `V11ArtifactAttestation` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
INSERT IGNORE INTO `Artifact` (
  `id`, `tenantId`, `kind`, `digest`, `sourceRevision`, `buildMetadata`, `createdAt`
)
SELECT
  UUID(),
  `tenantId`,
  MIN(`artifactType`),
  `artifactDigest`,
  MAX(`sourceRevision`),
  JSON_OBJECT(
    'buildPipeline', MAX(`buildPipeline`),
    'dependencyLockFileHash', MAX(`dependencyLockFileHash`)
  ),
  MIN(`createdAt`)
FROM `V11ArtifactAttestation`
WHERE `artifactDigest` REGEXP '^sha256:[0-9a-f]{64}$'
GROUP BY `tenantId`, `artifactDigest`;
--> statement-breakpoint
UPDATE `V11ArtifactAttestation` attestation
INNER JOIN `Artifact` artifact
  ON artifact.`tenantId` = attestation.`tenantId`
  AND artifact.`digest` = attestation.`artifactDigest`
SET attestation.`artifactId` = artifact.`id`
WHERE attestation.`artifactId` IS NULL;
--> statement-breakpoint
INSERT IGNORE INTO `AttestationRevocationRecord` (
  `id`, `tenantId`, `attestationId`, `revokedByType`, `revokedBy`, `reason`, `requestId`, `revokedAt`
)
SELECT
  UUID(),
  `tenantId`,
  `id`,
  'system',
  COALESCE(`revokedBy`, 'migration-0113'),
  COALESCE(`revocationReason`, 'Legacy attestation revocation'),
  CONCAT('migration-0113:', `id`),
  `revokedAt`
FROM `V11ArtifactAttestation`
WHERE `revokedAt` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `V11AgentRevision`
  ADD COLUMN `artifactId` varchar(36) NULL AFTER `agentArtifactRef`,
  ADD COLUMN `artifactDigest` varchar(71) NULL AFTER `artifactId`,
  ADD KEY `V11AgentRevision_artifact_idx` (`artifactId`),
  ADD CONSTRAINT `V11AgentRevision_artifactId_fk`
    FOREIGN KEY (`artifactId`) REFERENCES `Artifact` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
--> statement-breakpoint
ALTER TABLE `V11RuntimeRevision`
  ADD COLUMN `artifactId` varchar(36) NULL AFTER `runtimeArtifactRef`,
  ADD COLUMN `artifactDigest` varchar(71) NULL AFTER `artifactId`,
  ADD KEY `V11RuntimeRevision_artifact_idx` (`artifactId`),
  ADD CONSTRAINT `V11RuntimeRevision_artifactId_fk`
    FOREIGN KEY (`artifactId`) REFERENCES `Artifact` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
--> statement-breakpoint
UPDATE `V11AgentRevision` revision
INNER JOIN `V11Agent` agent ON agent.`id` = revision.`agentId`
INNER JOIN `Artifact` artifact
  ON artifact.`tenantId` = agent.`tenantId`
  AND artifact.`digest` = CASE
    WHEN revision.`agentArtifactRef` REGEXP '^sha256:[0-9a-f]{64}$'
      THEN revision.`agentArtifactRef`
    WHEN revision.`agentArtifactRef` REGEXP '@sha256:[0-9a-f]{64}$'
      THEN RIGHT(revision.`agentArtifactRef`, 71)
    ELSE NULL
  END
SET revision.`artifactId` = artifact.`id`, revision.`artifactDigest` = artifact.`digest`
WHERE revision.`artifactId` IS NULL;
--> statement-breakpoint
UPDATE `V11RuntimeRevision` revision
INNER JOIN `V11Runtime` runtime ON runtime.`id` = revision.`runtimeId`
INNER JOIN `Artifact` artifact
  ON artifact.`tenantId` = runtime.`tenantId`
  AND artifact.`digest` = CASE
    WHEN revision.`runtimeArtifactRef` REGEXP '^sha256:[0-9a-f]{64}$'
      THEN revision.`runtimeArtifactRef`
    WHEN revision.`runtimeArtifactRef` REGEXP '@sha256:[0-9a-f]{64}$'
      THEN RIGHT(revision.`runtimeArtifactRef`, 71)
    ELSE NULL
  END
SET revision.`artifactId` = artifact.`id`, revision.`artifactDigest` = artifact.`digest`
WHERE revision.`artifactId` IS NULL;
