-- V11 Stage 2: tenant, user_identity, principal_binding (S02-C01)
CREATE TABLE `Tenant` (
  `id` varchar(36) NOT NULL,
  `key` varchar(64) NOT NULL,
  `name` varchar(128) NOT NULL,
  `status` enum('active','suspended') NOT NULL DEFAULT 'active',
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `Tenant_key_uq`(`key`)
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `UserIdentity` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `externalSubject` varchar(128) NOT NULL,
  `email` varchar(128) NOT NULL,
  `displayName` text,
  `status` enum('active','disabled') NOT NULL DEFAULT 'active',
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `UserIdentity_tenant_subject_uq`(`tenantId`,`externalSubject`),
  KEY `UserIdentity_tenant_email_idx`(`tenantId`,`email`),
  CONSTRAINT `UserIdentity_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `PrincipalBinding` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `subjectType` enum('user','group','role','department') NOT NULL,
  `externalId` varchar(128) NOT NULL,
  `displayName` text,
  `userIdentityId` varchar(36) NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `PrincipalBinding_tenant_type_external_uq`(`tenantId`,`subjectType`,`externalId`),
  KEY `PrincipalBinding_tenant_user_idx`(`tenantId`,`userIdentityId`),
  CONSTRAINT `PrincipalBinding_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `PrincipalBinding_userIdentityId_fk` FOREIGN KEY (`userIdentityId`) REFERENCES `UserIdentity`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;
