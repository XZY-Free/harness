-- §06.4: Remove consumer state fields from Outbox table.
-- These fields belong exclusively to ControlPlaneEventDelivery.

ALTER TABLE `ControlPlaneOutboxEvent`
  DROP COLUMN `publishedAt`,
  DROP COLUMN `attemptCount`,
  DROP COLUMN `nextAttemptAt`,
  DROP COLUMN `lockedBy`,
  DROP COLUMN `lockExpiresAt`,
  DROP COLUMN `lastAttemptAt`,
  DROP COLUMN `lastErrorCode`,
  DROP COLUMN `lastErrorSummary`,
  DROP COLUMN `deadLetteredAt`,
  DROP COLUMN `maxAttempts`;
--> statement-breakpoint
-- Drop the claimable index that referenced removed columns
DROP INDEX `ControlPlaneOutboxEvent_claimable_idx` ON `ControlPlaneOutboxEvent`;
