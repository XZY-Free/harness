-- §3.3: 多消费者Delivery模型 — 创建 ControlPlaneEventDelivery 表
-- 参见：SnowHarness专题01全局统一与最终收敛方案 §3.3

CREATE TABLE `ControlPlaneEventDelivery` (
  `id` varchar(36) NOT NULL,
  `eventId` varchar(36) NOT NULL,
  `consumerName` varchar(128) NOT NULL,
  `state` varchar(32) NOT NULL DEFAULT 'pending',
  `attemptCount` int NOT NULL DEFAULT 0,
  `nextAttemptAt` datetime(3),
  `lockedBy` varchar(128),
  `lockExpiresAt` datetime(3),
  `lastErrorCode` varchar(64),
  `lastErrorSummary` text,
  `completedAt` datetime(3),
  `deadLetteredAt` datetime(3),
  `createdAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--> statement-breakpoint

CREATE UNIQUE INDEX `ControlPlaneEventDelivery_event_consumer_uq`
  ON `ControlPlaneEventDelivery` (`eventId`, `consumerName`);

--> statement-breakpoint

CREATE INDEX `ControlPlaneEventDelivery_claimable_idx`
  ON `ControlPlaneEventDelivery` (`state`, `consumerName`, `nextAttemptAt`, `lockExpiresAt`);
