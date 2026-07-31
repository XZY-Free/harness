-- V11 Stage 3: artifact_attestation (S03-C03)
CREATE TABLE `V11ArtifactAttestation` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `artifactType` varchar(32) NOT NULL,
  `artifactRevisionId` varchar(36) NOT NULL,
  `artifactDigest` varchar(128) NOT NULL,
  `signatureBundleRef` varchar(512) NOT NULL,
  `sbomRef` varchar(512) NOT NULL,
  `provenanceRef` varchar(512) NOT NULL,
  `builderIdentity` varchar(256) NOT NULL,
  `verificationState` varchar(32) NOT NULL,
  `policyRevisionId` varchar(36) NULL,
  `failureCode` varchar(64) NULL,
  `verifiedAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11ArtifactAttestation_tenant_type_rev_digest_sig_uq`(`tenantId`,`artifactType`,`artifactRevisionId`,`artifactDigest`,`signatureBundleRef`),
  KEY `V11ArtifactAttestation_tenant_type_rev_state_idx`(`tenantId`,`artifactType`,`artifactRevisionId`,`verificationState`),
  KEY `V11ArtifactAttestation_tenant_digest_idx`(`tenantId`,`artifactDigest`),
  CONSTRAINT `V11ArtifactAttestation_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
