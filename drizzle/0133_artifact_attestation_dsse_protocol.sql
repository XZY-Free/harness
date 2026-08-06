-- §02: 统一制品证明信任协议 — 重命名 signatureBundleRef → dsseEnvelopeRef，删除 sigstore 专用列
ALTER TABLE `ArtifactAttestation`
  CHANGE COLUMN `signatureBundleRef` `dsseEnvelopeRef` varchar(512) DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `ArtifactAttestation`
  DROP COLUMN `bundleRef`,
  DROP COLUMN `signingIdentity`,
  DROP COLUMN `oidcIssuer`,
  DROP COLUMN `certificateFingerprint`,
  DROP COLUMN `transparencyLogId`,
  DROP COLUMN `transparencyLogIndex`,
  DROP COLUMN `verificationPolicyRevisionId`;
--> statement-breakpoint
-- 收窄 attestationFormat 枚举为仅 in_toto_dsse
ALTER TABLE `ArtifactAttestation`
  MODIFY COLUMN `attestationFormat` ENUM('in_toto_dsse') NOT NULL DEFAULT 'in_toto_dsse';
--> statement-breakpoint
-- V11 前缀索引名（历史行）；重命名为正式名并改列引用
ALTER TABLE `ArtifactAttestation`
  DROP INDEX `V11ArtifactAttestation_tenant_type_rev_digest_sig_uq`,
  ADD UNIQUE INDEX `ArtifactAttestation_tenant_type_rev_digest_env_uq` (`tenantId`, `artifactType`, `artifactRevisionId`, `artifactDigest`, `dsseEnvelopeRef`);
