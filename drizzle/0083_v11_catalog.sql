-- V11 Stage 6 S06-C03: catalog_entry & catalog_revision（CatalogEntry 投影与员工目录）
--
-- 事实源：lib/v11/schema/catalog.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §4.5（catalog_entry 读模型）、
--         ../v11-agentkit-platform/12-capability-and-collaboration-api.md §2（Employee Catalog API）、
--         ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §2（统一目录）。
--
-- 关键约束：
-- - UNIQUE(tenantId, resourceType, resourceId)：资源在租户内目录唯一。
-- - UNIQUE(tenantId, audience)：每个租户每个 audience 一条修订游标。
-- - CatalogEntry 是只读投影读模型，由投影器从事实源派生，无 Admin API 直接写。
-- - CatalogRevision 是租户级目录修订游标，配合 ETag/If-None-Match 短路径 304。
-- - 任意资源投影刷新 → advanceCatalogRevision 推进 currentRevision。
CREATE TABLE `V11CatalogEntry` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `resourceType` varchar(32) NOT NULL,
  `resourceId` varchar(36) NOT NULL,
  `displayName` varchar(256) NOT NULL,
  `description` text NULL,
  `ownerUserId` varchar(36) NULL,
  `tagsJson` json NULL,
  `lifecycleState` varchar(32) NOT NULL,
  `visibilitySummary` varchar(64) NOT NULL,
  `sourceUpdatedAt` datetime(3) NOT NULL,
  `projectedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `catalogRevision` bigint NOT NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11CatalogEntry_tenant_resourceType_resourceId_uq`(`tenantId`,`resourceType`,`resourceId`),
  KEY `V11CatalogEntry_tenant_resourceType_lifecycle_idx`(`tenantId`,`resourceType`,`lifecycleState`),
  KEY `V11CatalogEntry_tenant_catalogRevision_idx`(`tenantId`,`catalogRevision`),
  CONSTRAINT `V11CatalogEntry_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11CatalogRevision` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `audience` enum('employee','runtime') NOT NULL,
  `currentRevision` bigint NOT NULL DEFAULT 0,
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11CatalogRevision_tenant_audience_uq`(`tenantId`,`audience`),
  CONSTRAINT `V11CatalogRevision_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
