-- V11 Stage 3: runtime & runtime_revision (S03-C02)
CREATE TABLE `V11Runtime` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `runtimeKey` varchar(128) NOT NULL,
  `displayName` varchar(256) NOT NULL,
  `runtimeKind` enum('hosted','external') NOT NULL,
  `ownerUserId` varchar(36) NOT NULL,
  `lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
  `currentRevisionId` varchar(36) NULL,
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11Runtime_tenant_runtimeKey_uq`(`tenantId`,`runtimeKey`),
  KEY `V11Runtime_tenant_lifecycle_updated_idx`(`tenantId`,`lifecycleState`,`updatedAt`),
  CONSTRAINT `V11Runtime_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11RuntimeRevision` (
  `id` varchar(36) NOT NULL,
  `runtimeId` varchar(36) NOT NULL,
  `revisionNo` bigint NOT NULL,
  `protocolType` varchar(32) NOT NULL,
  `endpointRef` varchar(512) NOT NULL,
  `runtimeArtifactRef` varchar(512) NOT NULL,
  `runtimeCapabilitiesJson` json NOT NULL,
  `identityMode` varchar(32) NOT NULL,
  `networkZone` varchar(32) NOT NULL,
  `configHash` varchar(128) NOT NULL,
  `revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
  `createdBy` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `publishedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11RuntimeRevision_runtime_revisionNo_uq`(`runtimeId`,`revisionNo`),
  KEY `V11RuntimeRevision_runtime_state_idx`(`runtimeId`,`revisionState`),
  CONSTRAINT `V11RuntimeRevision_runtimeId_fk` FOREIGN KEY (`runtimeId`) REFERENCES `V11Runtime`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
