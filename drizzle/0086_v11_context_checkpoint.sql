-- V11 Stage 7 S07-C02: context_checkpoint（可追溯上下文检查点）
--
-- 事实源：lib/v11/schema/context-checkpoint.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §7.5（context_checkpoint 表）、
--         ../v11-agentkit-platform/03-context-memory-and-knowledge.md §6（压缩）、§7（Trace）、§15（失败与恢复）、
--         ../v11-agentkit-platform/13-memory-and-job-api.md §3（Context Checkpoint API）。
--
-- 关键约束：
-- - UNIQUE(tenantId, invocationId, checkpointType, sourceRangesHash)：同 Invocation 同类型同来源范围不重复落库。
-- - INDEX(tenantId, invocationId, createdAt)：按 Invocation 查询 Checkpoint 历史。
-- - INDEX(tenantId, expiresAt)：按过期时间清理。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
-- - invocationId 不加 DB 级 FK（逻辑外键 → Invocation.id），避免跨阶段耦合。
-- - Checkpoint 不删除原始 Item/Event，不写 Memory，不保存 Credential/隐藏思维链。
-- - summaryRef 与 summaryRedacted 至少一个非空（route 层校验，DB 不强制）。
CREATE TABLE `V11ContextCheckpoint` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `checkpointType` enum('assembly','compression','resume') NOT NULL,
  `sourceRangesJson` json NOT NULL,
  `sourceRangesHash` varchar(128) NOT NULL,
  `summaryRef` varchar(512) NULL,
  `summaryRedacted` text NULL,
  `summaryHash` varchar(128) NOT NULL,
  `inputTokens` int NOT NULL,
  `retainedTokens` int NOT NULL,
  `compressedTokens` int NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` datetime(3) NOT NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11ContextCheckpoint_tenant_invocation_type_ranges_uq`(`tenantId`,`invocationId`,`checkpointType`,`sourceRangesHash`),
  KEY `V11ContextCheckpoint_tenant_invocation_created_idx`(`tenantId`,`invocationId`,`createdAt`),
  KEY `V11ContextCheckpoint_tenant_expires_idx`(`tenantId`,`expiresAt`),
  CONSTRAINT `V11ContextCheckpoint_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;