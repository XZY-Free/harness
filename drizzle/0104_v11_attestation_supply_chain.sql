-- S12-W04：制品证明供应链扩展。
--
-- 事实源：14-production-operations-security-and-retention.md §4.1（provenance/scan 必须在 MySQL 可查询）。
--
-- 变更：
-- 1. 持久化 provenance 摘要（sourceRevision/buildPipeline/dependencyLockFileHash/buildTime）。
-- 2. 持久化扫描摘要（scanSummaryJson：命中漏洞/许可证计数，不存原文漏洞细节）。
-- 3. 撤销语义（revokedAt/revokedBy/revocationReason）：撤销后阻止新 Invocation/发布/路由。

ALTER TABLE `V11ArtifactAttestation`
  ADD COLUMN `sourceRevision` varchar(128) NULL AFTER `policyRevisionId`,
  ADD COLUMN `buildPipeline` varchar(256) NULL AFTER `sourceRevision`,
  ADD COLUMN `dependencyLockFileHash` varchar(128) NULL AFTER `buildPipeline`,
  ADD COLUMN `buildTime` datetime(3) NULL AFTER `dependencyLockFileHash`,
  ADD COLUMN `scanSummaryJson` json NULL AFTER `buildTime`,
  ADD COLUMN `revokedAt` datetime(3) NULL AFTER `verifiedAt`,
  ADD COLUMN `revokedBy` varchar(128) NULL AFTER `revokedAt`,
  ADD COLUMN `revocationReason` text NULL AFTER `revokedBy`;--> statement-breakpoint
ALTER TABLE `V11ArtifactAttestation`
  ADD INDEX `V11ArtifactAttestation_tenant_revoked_idx` (`tenantId`, `revokedAt`);
