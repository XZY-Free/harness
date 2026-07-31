-- V11 Stage 7 S07-C03: memory_candidate / memory_entry / memory_source / memory_index
--
-- 事实源：lib/v11/schema/memory.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §7.5（Memory 与知识索引表）、
--         ../v11-agentkit-platform/03-context-memory-and-knowledge.md §8（作用域）、§9（挂载与检索）、
--         §10（写入路径）、§11（禁止内容与用户控制）、
--         ../v11-agentkit-platform/09-unified-domain-model.md §6.2（Memory 域模型边界）、
--         ../v11-agentkit-platform/13-memory-and-job-api.md §2（Memory Candidate API）。
--
-- 关键约束：
-- - UNIQUE(candidateKey)：同 Invocation 同来源同内容同 scope 不重复落库（invocation_id 全局唯一保证跨租户不冲突）。
-- - INDEX(tenantId, invocationId)：按 Invocation 查询候选历史。
-- - INDEX(tenantId, candidateState, proposedAt)：按状态分页查询 pending/needs_review 列表。
-- - INDEX(tenantId, proposedScopeType, proposedScopeRef)：按 scope 查询候选。
-- - memory_source UNIQUE(memoryEntryId, sourceType, sourceId, sourceHash)：同 Entry 同来源不重复关联。
-- - memory_index UNIQUE(memoryEntryId, indexProvider)：同 Entry 同 provider 只有一条索引。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
-- - memoryEntryId 外键 → V11MemoryEntry(id) ON DELETE CASCADE。
-- - invocationId / sourceItemId / sourceJobId / sourceArtifactId 等不加 DB 级 FK，避免跨阶段耦合。
-- - source_item_id / source_job_id / source_artifact_id 恰一个非空（route 层校验，DB 不强制）。
CREATE TABLE `V11MemoryCandidate` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `sourceThreadId` varchar(36) NULL,
  `sourceTurnId` varchar(36) NULL,
  `sourceItemId` varchar(36) NULL,
  `sourceJobId` varchar(36) NULL,
  `sourceArtifactId` varchar(36) NULL,
  `sourceHash` varchar(128) NOT NULL,
  `proposedScopeType` enum('thread','workspace','agent','user_preference','organization') NOT NULL,
  `proposedScopeRef` varchar(128) NULL,
  `memoryType` varchar(64) NOT NULL,
  `rationaleCode` varchar(64) NOT NULL,
  `contentRef` varchar(512) NULL,
  `contentRedacted` text NULL,
  `contentHash` varchar(128) NOT NULL,
  `candidateKey` varchar(128) NOT NULL,
  `sensitivityClass` enum('public','internal','confidential','restricted') NOT NULL,
  `candidateState` enum('submitted','accepted','rejected','needs_review','expired') NOT NULL,
  `decisionReasonCodesJson` json NULL,
  `resolvedMemoryEntryId` varchar(36) NULL,
  `requestedExpiresAt` datetime(3) NULL,
  `proposedAt` datetime(3) NOT NULL,
  `resolvedAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11MemoryCandidate_candidateKey_uq`(`candidateKey`),
  KEY `V11MemoryCandidate_tenant_invocation_idx`(`tenantId`,`invocationId`),
  KEY `V11MemoryCandidate_tenant_state_proposed_idx`(`tenantId`,`candidateState`,`proposedAt`),
  KEY `V11MemoryCandidate_tenant_scope_idx`(`tenantId`,`proposedScopeType`,`proposedScopeRef`),
  CONSTRAINT `V11MemoryCandidate_exactly_one_source_ck` CHECK (((`sourceItemId` IS NOT NULL) + (`sourceJobId` IS NOT NULL) + (`sourceArtifactId` IS NOT NULL)) = 1),
  CONSTRAINT `V11MemoryCandidate_accepted_entry_ck` CHECK (`candidateState` <> 'accepted' OR `resolvedMemoryEntryId` IS NOT NULL),
  CONSTRAINT `V11MemoryCandidate_rejected_entry_ck` CHECK (`candidateState` NOT IN ('rejected','expired') OR `resolvedMemoryEntryId` IS NULL),
  CONSTRAINT `V11MemoryCandidate_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11MemoryEntry` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `entryKey` varchar(128) NOT NULL,
  `scopeType` enum('thread','workspace','agent','user_preference','organization') NOT NULL,
  `scopeRef` varchar(128) NULL,
  `memoryType` varchar(64) NOT NULL,
  `contentRef` varchar(512) NULL,
  `contentRedacted` text NULL,
  `contentHash` varchar(128) NOT NULL,
  `sensitivityClass` enum('public','internal','confidential','restricted') NOT NULL,
  `memoryState` enum('active','archived','superseded') NOT NULL DEFAULT 'active',
  `validFrom` datetime(3) NOT NULL,
  `expiresAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11MemoryEntry_entryKey_uq`(`entryKey`),
  KEY `V11MemoryEntry_tenant_scope_idx`(`tenantId`,`scopeType`,`scopeRef`),
  KEY `V11MemoryEntry_tenant_state_updated_idx`(`tenantId`,`memoryState`,`updatedAt`),
  KEY `V11MemoryEntry_tenant_contentHash_idx`(`tenantId`,`contentHash`),
  CONSTRAINT `V11MemoryEntry_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11MemorySource` (
  `id` varchar(36) NOT NULL,
  `memoryEntryId` varchar(36) NOT NULL,
  `memoryCandidateId` varchar(36) NULL,
  `sourceType` enum('thread_item','job','artifact') NOT NULL,
  `sourceId` varchar(128) NOT NULL,
  `sourceHash` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11MemorySource_entry_type_id_hash_uq`(`memoryEntryId`,`sourceType`,`sourceId`,`sourceHash`),
  KEY `V11MemorySource_candidate_idx`(`memoryCandidateId`),
  CONSTRAINT `V11MemorySource_memoryEntryId_fk` FOREIGN KEY (`memoryEntryId`) REFERENCES `V11MemoryEntry`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11MemoryIndex` (
  `id` varchar(36) NOT NULL,
  `memoryEntryId` varchar(36) NOT NULL,
  `indexProvider` varchar(64) NOT NULL,
  `indexRef` varchar(512) NOT NULL,
  `embeddingModelRef` varchar(128) NULL,
  `contentHash` varchar(128) NOT NULL,
  `indexedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11MemoryIndex_entry_provider_uq`(`memoryEntryId`,`indexProvider`),
  CONSTRAINT `V11MemoryIndex_memoryEntryId_fk` FOREIGN KEY (`memoryEntryId`) REFERENCES `V11MemoryEntry`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
