ALTER TABLE `V11ExecutionBinding`
  ADD COLUMN `routeRevisionId` varchar(36) NULL AFTER `contextCheckpointId`,
  ADD COLUMN `routeActivationId` varchar(36) NULL AFTER `routeRevisionId`,
  ADD COLUMN `routeContentDigest` varchar(71) NULL AFTER `routeActivationId`,
  ADD COLUMN `agentArtifactDigest` varchar(71) NULL AFTER `routeContentDigest`,
  ADD COLUMN `runtimeArtifactDigest` varchar(71) NULL AFTER `agentArtifactDigest`,
  ADD COLUMN `runtimeConfigDigest` varchar(71) NULL AFTER `runtimeArtifactDigest`,
  ADD COLUMN `capabilityManifestDigest` varchar(71) NULL AFTER `runtimeConfigDigest`,
  ADD COLUMN `agentAttestationIds` json NULL AFTER `capabilityManifestDigest`,
  ADD COLUMN `runtimeAttestationIds` json NULL AFTER `agentAttestationIds`,
  ADD COLUMN `agentPublicationRecordId` varchar(36) NULL AFTER `runtimeAttestationIds`,
  ADD COLUMN `runtimePublicationRecordId` varchar(36) NULL AFTER `agentPublicationRecordId`,
  ADD COLUMN `conformanceRunId` varchar(36) NULL AFTER `runtimePublicationRecordId`,
  ADD COLUMN `environmentDefinitionRevisionId` varchar(36) NULL AFTER `conformanceRunId`,
  ADD KEY `V11ExecutionBinding_routeRevision_idx` (`routeRevisionId`),
  ADD KEY `V11ExecutionBinding_conformanceRun_idx` (`conformanceRunId`),
  ADD CONSTRAINT `V11ExecutionBinding_routeRevisionId_fk`
    FOREIGN KEY (`routeRevisionId`) REFERENCES `RouteRevision` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `V11ExecutionBinding_routeActivationId_fk`
    FOREIGN KEY (`routeActivationId`) REFERENCES `RouteActivation` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `V11ExecutionBinding_agentPublicationRecordId_fk`
    FOREIGN KEY (`agentPublicationRecordId`) REFERENCES `PublicationRecord` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `V11ExecutionBinding_runtimePublicationRecordId_fk`
    FOREIGN KEY (`runtimePublicationRecordId`) REFERENCES `PublicationRecord` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `V11ExecutionBinding_conformanceRunId_fk`
    FOREIGN KEY (`conformanceRunId`) REFERENCES `RuntimeConformanceRun` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
