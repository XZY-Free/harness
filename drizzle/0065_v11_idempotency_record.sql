-- V11 Stage 2: idempotency_record (S02-C04)
CREATE TABLE `IdempotencyRecord` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `audience` enum('employee','runtime','gateway','admin') NOT NULL,
  `callerType` enum('user','device','workload','service') NOT NULL,
  `callerId` varchar(128) NOT NULL,
  `commandScope` varchar(128) NOT NULL,
  `idempotencyKey` varchar(256) NOT NULL,
  `requestHash` varchar(64) NOT NULL,
  `processingState` enum('processing','completed','failed') NOT NULL DEFAULT 'processing',
  `httpStatus` int NULL,
  `responseRef` varchar(128) NULL,
  `responseRedactedJson` text NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` datetime(3) NULL,
  `expiresAt` datetime(3) NOT NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `IdempotencyRecord_tenant_audience_caller_scope_key_uq`(`tenantId`,`audience`,`callerType`,`callerId`,`commandScope`,`idempotencyKey`),
  KEY `IdempotencyRecord_tenant_expires_idx`(`tenantId`,`expiresAt`),
  CONSTRAINT `IdempotencyRecord_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
