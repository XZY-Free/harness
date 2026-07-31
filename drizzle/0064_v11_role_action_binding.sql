-- V11 Stage 2: role_action_binding (S02-C03)
CREATE TABLE `RoleActionBinding` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `principalBindingId` varchar(36) NOT NULL,
  `actionCode` varchar(64) NOT NULL,
  `resourceScopeJson` text NOT NULL,
  `validFrom` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `validUntil` datetime(3) NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(`id`),
  KEY `RoleActionBinding_tenant_principal_idx`(`tenantId`,`principalBindingId`),
  KEY `RoleActionBinding_tenant_action_idx`(`tenantId`,`actionCode`),
  CONSTRAINT `RoleActionBinding_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `RoleActionBinding_principalBindingId_fk` FOREIGN KEY (`principalBindingId`) REFERENCES `PrincipalBinding`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
