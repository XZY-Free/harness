-- §6.2: HostedProvisioningRequest Step Checkpoint 字段
-- 每步完成后持久化产出，Saga 后续步骤只使用已保存输出

ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepAgentRevisionId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepAgentPublicationRecordId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepAgentAttestationId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepRuntimeRevisionId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepRuntimePublicationRecordId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepRuntimeAttestationId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepConformanceRunId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepRouteSetId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepRouteSetVersionNo` int;
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepRouteRevisionId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `stepRouteActivationId` varchar(36);
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `workflowVersion` varchar(16) NOT NULL DEFAULT '2.0';
--> statement-breakpoint
ALTER TABLE `HostedProvisioningRequest` ADD COLUMN `lastCompletedStep` varchar(64);
