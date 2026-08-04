-- Migration 0123: Attestation Envelope 标准字段扩展。
--
-- 在 V11ArtifactAttestation 表增加 in-toto/DSSE/Sigstore 标准字段。
-- 同时将旧字段 signatureBundleRef/sbomRef/provenanceRef/builderIdentity 改为允许 NULL。
-- 历史记录保留 legacy_custom 格式；新记录默认必须使用标准格式。

ALTER TABLE `V11ArtifactAttestation`
  ADD COLUMN `attestationFormat` enum('legacy_custom','in_toto_dsse','sigstore_bundle') NOT NULL DEFAULT 'legacy_custom',
  ADD COLUMN `statementType` varchar(128),
  ADD COLUMN `predicateType` varchar(256),
  ADD COLUMN `bundleRef` varchar(512),
  ADD COLUMN `bundleDigest` varchar(71),
  ADD COLUMN `subjectName` varchar(256),
  ADD COLUMN `subjectDigest` varchar(71),
  ADD COLUMN `signingIdentity` varchar(256),
  ADD COLUMN `oidcIssuer` varchar(256),
  ADD COLUMN `certificateFingerprint` varchar(128),
  ADD COLUMN `transparencyLogId` varchar(128),
  ADD COLUMN `transparencyLogIndex` bigint,
  ADD COLUMN `verificationPolicyRevisionId` varchar(36),
  ADD COLUMN `verificationEngine` varchar(64),
  ADD COLUMN `verificationEngineVersion` varchar(32);

--> statement-breakpoint

-- 将旧字段改为允许 NULL — 历史记录保留值，新记录不再写入。
ALTER TABLE `V11ArtifactAttestation`
  MODIFY `signatureBundleRef` varchar(512),
  MODIFY `sbomRef` varchar(512),
  MODIFY `provenanceRef` varchar(512),
  MODIFY `builderIdentity` varchar(256);

--> statement-breakpoint

-- 添加索引：按格式查询
CREATE INDEX `V11ArtifactAttestation_tenant_format_idx`
  ON `V11ArtifactAttestation` (`tenantId`, `attestationFormat`, `createdAt`);

--> statement-breakpoint

-- RuntimeConformanceRun 增加 conformanceFormat 字段
ALTER TABLE `RuntimeConformanceRun`
  ADD COLUMN `conformanceFormat` enum('legacy_hmac','standard_dsse') NOT NULL DEFAULT 'legacy_hmac';

--> statement-breakpoint

CREATE INDEX `RuntimeConformanceRun_tenant_format_idx`
  ON `RuntimeConformanceRun` (`tenantId`, `conformanceFormat`, `completedAt`);
