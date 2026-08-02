CREATE TABLE `PublicationRecord` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `subjectType` enum('agent_revision','runtime_revision') NOT NULL,
  `subjectRevisionId` varchar(36) NOT NULL,
  `publicationSequence` bigint unsigned NOT NULL AUTO_INCREMENT,
  `evidenceSetDigest` varchar(71) NOT NULL,
  `attestationIds` json NOT NULL,
  `conformanceRunId` varchar(36) NULL,
  `approvals` json NOT NULL,
  `publishedByType` enum('user','service','workload','system') NOT NULL,
  `publishedBy` varchar(128) NOT NULL,
  `publishedAt` datetime(3) NOT NULL,
  `idempotencyKey` varchar(255) NOT NULL,
  `idempotencyRecordId` varchar(36) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `PublicationRecord_subject_uq` (`subjectType`, `subjectRevisionId`),
  UNIQUE KEY `PublicationRecord_sequence_uq` (`publicationSequence`),
  UNIQUE KEY `PublicationRecord_idempotencyRecord_uq` (`idempotencyRecordId`),
  KEY `PublicationRecord_tenant_published_idx` (`tenantId`, `publishedAt`),
  CONSTRAINT `PublicationRecord_tenantId_fk`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE `WithdrawalRecord` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `publicationRecordId` varchar(36) NOT NULL,
  `subjectType` enum('agent_revision','runtime_revision') NOT NULL,
  `subjectRevisionId` varchar(36) NOT NULL,
  `reasonCode` varchar(64) NOT NULL,
  `reason` text NOT NULL,
  `withdrawnByType` enum('user','service','workload','system') NOT NULL,
  `withdrawnBy` varchar(128) NOT NULL,
  `withdrawnAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `WithdrawalRecord_subject_uq` (`subjectType`, `subjectRevisionId`),
  UNIQUE KEY `WithdrawalRecord_publicationRecord_uq` (`publicationRecordId`),
  KEY `WithdrawalRecord_tenant_withdrawn_idx` (`tenantId`, `withdrawnAt`),
  CONSTRAINT `WithdrawalRecord_tenantId_fk`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `WithdrawalRecord_publicationRecordId_fk`
    FOREIGN KEY (`publicationRecordId`) REFERENCES `PublicationRecord` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
INSERT INTO `PublicationRecord` (
  `id`,
  `tenantId`,
  `subjectType`,
  `subjectRevisionId`,
  `evidenceSetDigest`,
  `attestationIds`,
  `conformanceRunId`,
  `approvals`,
  `publishedByType`,
  `publishedBy`,
  `publishedAt`,
  `idempotencyKey`,
  `idempotencyRecordId`
)
SELECT
  UUID(),
  agent.`tenantId`,
  'agent_revision',
  revision.`id`,
  CONCAT('sha256:', SHA2(CONCAT('legacy-agent-revision:', revision.`id`, ':projection-only'), 256)),
  JSON_ARRAY(),
  NULL,
  JSON_ARRAY(),
  'system',
  'migration-0112',
  COALESCE(revision.`publishedAt`, revision.`createdAt`),
  CONCAT('migration:0112:agent:', revision.`id`),
  NULL
FROM `V11AgentRevision` revision
INNER JOIN `V11Agent` agent ON agent.`id` = revision.`agentId`
WHERE revision.`revisionState` IN ('published', 'withdrawn')
  AND NOT EXISTS (
    SELECT 1
    FROM `PublicationRecord` existing
    WHERE existing.`subjectType` = 'agent_revision'
      AND existing.`subjectRevisionId` = revision.`id`
  )
ORDER BY COALESCE(revision.`publishedAt`, revision.`createdAt`), revision.`id`;
--> statement-breakpoint
INSERT INTO `PublicationRecord` (
  `id`,
  `tenantId`,
  `subjectType`,
  `subjectRevisionId`,
  `evidenceSetDigest`,
  `attestationIds`,
  `conformanceRunId`,
  `approvals`,
  `publishedByType`,
  `publishedBy`,
  `publishedAt`,
  `idempotencyKey`,
  `idempotencyRecordId`
)
SELECT
  UUID(),
  runtime.`tenantId`,
  'runtime_revision',
  revision.`id`,
  CONCAT('sha256:', SHA2(CONCAT('legacy-runtime-revision:', revision.`id`, ':projection-only'), 256)),
  JSON_ARRAY(),
  NULL,
  JSON_ARRAY(),
  'system',
  'migration-0112',
  COALESCE(revision.`publishedAt`, revision.`createdAt`),
  CONCAT('migration:0112:runtime:', revision.`id`),
  NULL
FROM `V11RuntimeRevision` revision
INNER JOIN `V11Runtime` runtime ON runtime.`id` = revision.`runtimeId`
WHERE revision.`revisionState` IN ('published', 'withdrawn')
  AND NOT EXISTS (
    SELECT 1
    FROM `PublicationRecord` existing
    WHERE existing.`subjectType` = 'runtime_revision'
      AND existing.`subjectRevisionId` = revision.`id`
  )
ORDER BY COALESCE(revision.`publishedAt`, revision.`createdAt`), revision.`id`;
--> statement-breakpoint
INSERT INTO `WithdrawalRecord` (
  `id`,
  `tenantId`,
  `publicationRecordId`,
  `subjectType`,
  `subjectRevisionId`,
  `reasonCode`,
  `reason`,
  `withdrawnByType`,
  `withdrawnBy`,
  `withdrawnAt`
)
SELECT
  UUID(),
  publication.`tenantId`,
  publication.`id`,
  publication.`subjectType`,
  publication.`subjectRevisionId`,
  'legacy_state_backfill',
  'Migration 0112 observed a withdrawn AgentRevision projection; original withdrawal metadata was unavailable.',
  'system',
  'migration-0112',
  CURRENT_TIMESTAMP(3)
FROM `PublicationRecord` publication
INNER JOIN `V11AgentRevision` revision
  ON publication.`subjectType` = 'agent_revision'
  AND publication.`subjectRevisionId` = revision.`id`
WHERE revision.`revisionState` = 'withdrawn'
  AND NOT EXISTS (
    SELECT 1
    FROM `WithdrawalRecord` existing
    WHERE existing.`subjectType` = 'agent_revision'
      AND existing.`subjectRevisionId` = revision.`id`
  );
--> statement-breakpoint
INSERT INTO `WithdrawalRecord` (
  `id`,
  `tenantId`,
  `publicationRecordId`,
  `subjectType`,
  `subjectRevisionId`,
  `reasonCode`,
  `reason`,
  `withdrawnByType`,
  `withdrawnBy`,
  `withdrawnAt`
)
SELECT
  UUID(),
  publication.`tenantId`,
  publication.`id`,
  publication.`subjectType`,
  publication.`subjectRevisionId`,
  'legacy_state_backfill',
  'Migration 0112 observed a withdrawn RuntimeRevision projection; original withdrawal metadata was unavailable.',
  'system',
  'migration-0112',
  CURRENT_TIMESTAMP(3)
FROM `PublicationRecord` publication
INNER JOIN `V11RuntimeRevision` revision
  ON publication.`subjectType` = 'runtime_revision'
  AND publication.`subjectRevisionId` = revision.`id`
WHERE revision.`revisionState` = 'withdrawn'
  AND NOT EXISTS (
    SELECT 1
    FROM `WithdrawalRecord` existing
    WHERE existing.`subjectType` = 'runtime_revision'
      AND existing.`subjectRevisionId` = revision.`id`
  );
