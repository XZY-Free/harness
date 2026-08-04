ALTER TABLE `ControlPlaneOutboxEvent`
  ADD COLUMN `availableAt` datetime(3),
  ADD COLUMN `nextAttemptAt` datetime(3),
  ADD COLUMN `lockedBy` varchar(128),
  ADD COLUMN `lockExpiresAt` datetime(3),
  ADD COLUMN `lastAttemptAt` datetime(3),
  ADD COLUMN `lastErrorCode` varchar(64),
  ADD COLUMN `lastErrorSummary` text,
  ADD COLUMN `deadLetteredAt` datetime(3),
  ADD COLUMN `maxAttempts` int;

--> statement-breakpoint

CREATE INDEX `ControlPlaneOutboxEvent_claimable_idx`
  ON `ControlPlaneOutboxEvent` (`publishedAt`, `deadLetteredAt`, `nextAttemptAt`, `lockExpiresAt`);

--> statement-breakpoint

DROP INDEX `ControlPlaneOutboxEvent_unpublished_idx` ON `ControlPlaneOutboxEvent`;

--> statement-breakpoint

CREATE INDEX `ControlPlaneOutboxEvent_aggregate_occurred_idx`
  ON `ControlPlaneOutboxEvent` (`aggregateType`, `aggregateId`, `occurredAt`);
