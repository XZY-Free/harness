-- §08.5: Remove unused states and §08.9: Add new checkpoint columns
-- for Hosted Provisioning Saga step-level control.

-- §08.9: New checkpoint columns
ALTER TABLE `HostedProvisioningRequest`
  ADD COLUMN `stepRuntimeId` varchar(36) AFTER `stepAgentAttestationId`,
  ADD COLUMN `stepRuntimeArtifactId` varchar(36) AFTER `stepRuntimeRevisionId`,
  ADD COLUMN `stepRuntimeAttestationIds` json AFTER `stepRuntimeArtifactId`,
  ADD COLUMN `stepRouteId` varchar(36) AFTER `stepRouteSetVersionNo`,
  ADD COLUMN `stepProjectionVersionNo` int AFTER `stepRouteActivationId`;
--> statement-breakpoint
-- §08.5: Remove unused states — MySQL ENUM cannot drop members,
-- so we alter the ENUM to only include valid states.
-- Note: ALTER ENUM requires recreating the column with the new enum type.
ALTER TABLE `HostedProvisioningRequest`
  MODIFY COLUMN `state` ENUM('pending','running','ready','retryable_failed','permanent_failed','cancelled') NOT NULL DEFAULT 'pending';
--> statement-breakpoint
-- §08.4: Update workflowVersion to 3.0
ALTER TABLE `HostedProvisioningRequest`
  MODIFY COLUMN `workflowVersion` varchar(16) NOT NULL DEFAULT '3.0';
