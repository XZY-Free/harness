ALTER TABLE `ExecutionBinding` MODIFY COLUMN `agentArtifactId` varchar(36);--> statement-breakpoint
ALTER TABLE `ExecutionBinding` MODIFY COLUMN `agentArtifactDigest` varchar(71);--> statement-breakpoint
ALTER TABLE `ExecutionBinding` MODIFY COLUMN `agentAttestationIds` json;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` MODIFY COLUMN `agentPublicationRecordId` varchar(36);--> statement-breakpoint
-- 基础 Harness Route（agentRevisionId=null）的 agentAttestationIds 为 null（§18 not_applicable），
-- 删除非空 CHECK；保留 runtimeAttestationIdsNonEmpty。
ALTER TABLE `ExecutionBinding` DROP CHECK `ExecutionBinding_agentAttestationIds_non_empty`;