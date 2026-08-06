-- §06.4: Remove consumer state fields from Outbox table.
-- These fields belong exclusively to ControlPlaneEventDelivery.
-- Note: ControlPlaneOutboxEvent_claimable_idx is implicitly dropped
-- when its referencing columns are removed.

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
