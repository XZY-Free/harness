CREATE TABLE `ControlPlaneOutboxEvent` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `eventKey` varchar(256) NOT NULL,
  `eventType` varchar(128) NOT NULL,
  `aggregateType` varchar(64) NOT NULL,
  `aggregateId` varchar(128) NOT NULL,
  `payloadJson` json NOT NULL,
  `occurredAt` datetime(3) NOT NULL,
  `publishedAt` datetime(3) NULL,
  `attemptCount` int NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ControlPlaneOutboxEvent_eventKey_uq` (`eventKey`),
  KEY `ControlPlaneOutboxEvent_unpublished_idx` (`publishedAt`, `occurredAt`),
  KEY `ControlPlaneOutboxEvent_aggregate_idx` (`aggregateType`, `aggregateId`),
  CONSTRAINT `ControlPlaneOutboxEvent_tenantId_fk`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
