-- V11 Stage 3: deployment_route_set & deployment_route (S03-C04)
CREATE TABLE `V11DeploymentRouteSet` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `agentId` varchar(36) NOT NULL,
  `routeScopeKey` varchar(128) NOT NULL,
  `routeScopeJson` json NOT NULL,
  `versionNo` bigint unsigned NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11DeploymentRouteSet_tenant_agent_scope_uq`(`tenantId`,`agentId`,`routeScopeKey`),
  KEY `V11DeploymentRouteSet_tenant_agent_scope_idx`(`tenantId`,`agentId`,`routeScopeKey`),
  CONSTRAINT `V11DeploymentRouteSet_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11DeploymentRoute` (
  `id` varchar(36) NOT NULL,
  `routeSetId` varchar(36) NOT NULL,
  `agentRevisionId` varchar(36) NOT NULL,
  `runtimeRevisionId` varchar(36) NOT NULL,
  `trafficWeight` int NOT NULL,
  `priorityNo` int NOT NULL DEFAULT 0,
  `routeState` enum('enabled','disabled') NOT NULL DEFAULT 'enabled',
  `effectiveFrom` datetime(3) NULL,
  `effectiveUntil` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11DeploymentRoute_set_agent_runtime_uq`(`routeSetId`,`agentRevisionId`,`runtimeRevisionId`),
  KEY `V11DeploymentRoute_set_state_idx`(`routeSetId`,`routeState`),
  KEY `V11DeploymentRoute_agentRevision_idx`(`agentRevisionId`),
  KEY `V11DeploymentRoute_runtimeRevision_idx`(`runtimeRevisionId`),
  CONSTRAINT `V11DeploymentRoute_routeSetId_fk` FOREIGN KEY (`routeSetId`) REFERENCES `V11DeploymentRouteSet`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
