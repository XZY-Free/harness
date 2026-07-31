-- V11 Stage 2: device table (S02-C02)
-- Migrate DesktopDevice to V11 device table with tenant_id, device_key, device_state.
-- Private key only in Desktop Keychain, never in DB (10-core-data-model.md §2.1).
CREATE TABLE `Device` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `userId` varchar(36) NOT NULL,
  `deviceKey` varchar(128) NOT NULL,
  `publicKey` text NOT NULL,
  `deviceName` varchar(256) NOT NULL,
  `appVersion` varchar(32) NOT NULL,
  `deviceState` enum('active','revoked') NOT NULL DEFAULT 'active',
  `lastActiveAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `revokedAt` datetime NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(`id`),
  UNIQUE KEY `Device_tenant_key_uq`(`tenantId`,`deviceKey`),
  KEY `Device_tenant_user_idx`(`tenantId`,`userId`),
  KEY `Device_tenant_state_idx`(`tenantId`,`deviceState`),
  CONSTRAINT `Device_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `Device_userId_fk` FOREIGN KEY (`userId`) REFERENCES `UserIdentity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE INDEX `Device_tenant_user_state_idx` ON `Device` (`tenantId`,`userId`,`deviceState`);
