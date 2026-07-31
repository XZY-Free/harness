-- V11 Stage 2: audit_event (S02-C05)
CREATE TABLE `AuditEvent` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `actorType` enum('user','service','workload','system') NOT NULL,
  `actorId` varchar(128) NOT NULL,
  `actionType` varchar(64) NOT NULL,
  `targetType` varchar(64) NOT NULL,
  `targetId` varchar(128) NULL,
  `beforeHash` varchar(64) NULL,
  `afterHash` varchar(64) NULL,
  `reason` text NULL,
  `requestId` varchar(64) NOT NULL,
  `occurredAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  KEY `AuditEvent_tenant_occurred_idx`(`tenantId`,`occurredAt`),
  KEY `AuditEvent_tenant_actor_idx`(`tenantId`,`actorType`,`actorId`),
  KEY `AuditEvent_tenant_target_idx`(`tenantId`,`targetType`,`targetId`),
  KEY `AuditEvent_tenant_action_idx`(`tenantId`,`actionType`),
  CONSTRAINT `AuditEvent_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
