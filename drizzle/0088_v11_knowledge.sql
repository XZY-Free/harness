-- V11 Stage 7 S07-C05: knowledge_base / knowledge_document /
-- knowledge_document_revision / knowledge_chunk / knowledge_index
--
-- 事实源：lib/v11/schema/knowledge.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §4.4（knowledge_base/document/revision 字段）、
--         §7.5（knowledge_chunk / knowledge_index 索引表）、
--         ../v11-agentkit-platform/03-context-memory-and-knowledge.md §12（Knowledge Base）、
--         §13（Knowledge 加载：先目录后证据 / 数据保持最新 / 检索失败区分）、§14（与 Skill/Tool 边界）、
--         ../v11-agentkit-platform/09-unified-domain-model.md §6（域模型边界）、
--         ../v11-agentkit-platform-development-plan/07-context-memory-and-knowledge.md S07-W06。
--
-- 关键约束：
-- - UNIQUE(tenantId, knowledgeKey)：租户内 KnowledgeBase 稳定身份（Agent 绑定引用）。
-- - UNIQUE(knowledgeBaseId, documentKey)：KnowledgeBase 内 Document 稳定身份（跨修订引用）。
-- - UNIQUE(documentId, revisionNo)：文档内修订号唯一（单调递增）。
-- - UNIQUE(documentRevisionId, chunkNo)：修订内 Chunk 序号唯一。
-- - UNIQUE(chunkId, indexProvider)：同 Chunk 同 provider 只有一条索引记录。
-- - knowledge_document_revision 不可变：contentRef/contentRedacted/contentHash/aclSnapshotJson 创建后不修改。
-- - 索引完成后才切换 knowledge_document.current_revision_id（route 层校验）。
-- - 全文/向量/图谱是 KnowledgeBase 内部检索方式；Agent 只绑定 KnowledgeBase。
-- - knowledge_index 可重建，权限仍来自 Knowledge 文档（不复制权限到索引）。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
-- - knowledgeBaseId/documentId/documentRevisionId/chunkId 外键 ON DELETE CASCADE，级联清理。
CREATE TABLE `V11KnowledgeBase` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `knowledgeKey` varchar(128) NOT NULL,
  `displayName` varchar(256) NOT NULL,
  `description` text NULL,
  `ownerUserId` varchar(36) NULL,
  `visibilityPolicyId` varchar(36) NULL,
  `indexState` enum('pending','indexing','ready','failed','stale') NOT NULL DEFAULT 'pending',
  `lifecycleState` enum('active','archived','deleted') NOT NULL DEFAULT 'active',
  `versionNo` varchar(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11KnowledgeBase_tenant_key_uq`(`tenantId`,`knowledgeKey`),
  KEY `V11KnowledgeBase_tenant_lifecycle_idx`(`tenantId`,`lifecycleState`),
  KEY `V11KnowledgeBase_tenant_owner_idx`(`tenantId`,`ownerUserId`),
  CONSTRAINT `V11KnowledgeBase_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11KnowledgeDocument` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `knowledgeBaseId` varchar(36) NOT NULL,
  `documentKey` varchar(128) NOT NULL,
  `title` varchar(512) NOT NULL,
  `sourceType` enum('upload','external_url','manual','synced','generated') NOT NULL,
  `sourceRef` varchar(512) NULL,
  `currentRevisionId` varchar(36) NULL,
  `lifecycleState` enum('active','archived','deleted') NOT NULL DEFAULT 'active',
  `versionNo` varchar(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11KnowledgeDocument_base_key_uq`(`knowledgeBaseId`,`documentKey`),
  KEY `V11KnowledgeDocument_tenant_base_idx`(`tenantId`,`knowledgeBaseId`),
  KEY `V11KnowledgeDocument_tenant_lifecycle_idx`(`tenantId`,`lifecycleState`),
  CONSTRAINT `V11KnowledgeDocument_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11KnowledgeDocument_knowledgeBaseId_fk` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `V11KnowledgeBase`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11KnowledgeDocumentRevision` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `documentId` varchar(36) NOT NULL,
  `revisionNo` varchar(32) NOT NULL,
  `contentRef` varchar(512) NULL,
  `contentRedacted` text NULL,
  `contentHash` varchar(128) NOT NULL,
  `aclSnapshotHash` varchar(128) NULL,
  `aclSnapshotJson` json NULL,
  `indexState` enum('pending','indexing','ready','failed','stale') NOT NULL DEFAULT 'pending',
  `revisionState` enum('draft','published','superseded','retracted') NOT NULL DEFAULT 'draft',
  `createdBy` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `publishedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11KnowledgeDocumentRevision_doc_rev_uq`(`documentId`,`revisionNo`),
  KEY `V11KnowledgeDocumentRevision_tenant_doc_idx`(`tenantId`,`documentId`),
  KEY `V11KnowledgeDocumentRevision_tenant_state_idx`(`tenantId`,`revisionState`),
  CONSTRAINT `V11KnowledgeDocumentRevision_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11KnowledgeDocumentRevision_documentId_fk` FOREIGN KEY (`documentId`) REFERENCES `V11KnowledgeDocument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11KnowledgeChunk` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `documentRevisionId` varchar(36) NOT NULL,
  `chunkNo` varchar(32) NOT NULL,
  `contentRef` varchar(512) NULL,
  `contentRedacted` text NULL,
  `contentHash` varchar(128) NOT NULL,
  `metadataJson` json NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11KnowledgeChunk_revision_chunk_uq`(`documentRevisionId`,`chunkNo`),
  KEY `V11KnowledgeChunk_tenant_revision_idx`(`tenantId`,`documentRevisionId`),
  CONSTRAINT `V11KnowledgeChunk_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11KnowledgeChunk_documentRevisionId_fk` FOREIGN KEY (`documentRevisionId`) REFERENCES `V11KnowledgeDocumentRevision`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11KnowledgeIndex` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `chunkId` varchar(36) NOT NULL,
  `indexProvider` varchar(64) NOT NULL,
  `indexRef` varchar(512) NOT NULL,
  `embeddingModelRef` varchar(128) NULL,
  `contentHash` varchar(128) NOT NULL,
  `indexedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11KnowledgeIndex_chunk_provider_uq`(`chunkId`,`indexProvider`),
  KEY `V11KnowledgeIndex_tenant_provider_idx`(`tenantId`,`indexProvider`),
  CONSTRAINT `V11KnowledgeIndex_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11KnowledgeIndex_chunkId_fk` FOREIGN KEY (`chunkId`) REFERENCES `V11KnowledgeChunk`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
