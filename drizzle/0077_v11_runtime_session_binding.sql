-- V11 Stage 5 S05-C02: runtime_session_binding 表（Runtime 维护的会话引用）
--
-- 事实源：lib/v11/schema/runtime.ts、
--         docs/solutions/v11-agentkit-platform/10-core-data-model.md §6.11 L506-508
--
-- 关键约束：
-- - threadId/jobId 恰有一个非空（应用层校验，DB 不加 CHECK）。
-- - externalSessionRef 由 Runtime 颁发，平台仅持久化引用，不解析其内容。
-- - UNIQUE(runtimeRevisionId, externalSessionRef)：同一 RuntimeRevision 下外部会话引用唯一。
-- - 外部 Session 不取代 Thread，仅作为 Runtime 侧执行上下文锚点。
CREATE TABLE `V11RuntimeSessionBinding` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `runtimeRevisionId` varchar(36) NOT NULL,
  `threadId` varchar(36) NULL,
  `jobId` varchar(36) NULL,
  `externalSessionRef` varchar(256) NOT NULL,
  `bindingState` enum('active','closed','lost') NOT NULL DEFAULT 'active',
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `closedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11RuntimeSessionBinding_runtime_external_ref_uq`(`runtimeRevisionId`,`externalSessionRef`),
  KEY `V11RuntimeSessionBinding_thread_idx`(`threadId`),
  KEY `V11RuntimeSessionBinding_job_idx`(`jobId`),
  CONSTRAINT `V11RuntimeSessionBinding_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
