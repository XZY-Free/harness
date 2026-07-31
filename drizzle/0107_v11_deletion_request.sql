-- S12-W07：可验证删除请求与步骤表。
--
-- 事实源：14-production-operations-security-and-data-lifecycle.md §7
--         （删除请求生成独立生命周期，先解析对象关系与 Legal Hold，再进入各存储 Adapter；
--           覆盖 MySQL、对象存储、向量/检索、Trace/Log 和缓存；
--           部分失败保持 failed/partial 并可安全重试，不以"主表已删"宣称全部完成）。
--
-- 变更：
-- 1. 新建 V11DeletionRequest 表：删除请求主体。记录 subject/mode/reason/请求人/状态机/阻塞原因/审计事件 id。
--    requestState 推进：planning → blocked_by_hold（Legal Hold 阻止）/ deleting → completed/partial/failed。
-- 2. 新建 V11DeletionStep 表：每个存储 Adapter 的删除步骤。按 (requestId, storeType, subjectRef) 唯一。
--    completed 要求存储端 evidenceRef；局部失败保持 failed/partial，幂等可重试。
-- 3. Legal Hold 不扩大到无关对象：仅匹配的 target 被阻止删除。
-- 4. 不写 ThreadEvent 冒充已删除，只写管理域 AuditEvent（deletion.request）。

CREATE TABLE `V11DeletionRequest` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `subjectType` enum('thread','memory_entry','artifact','user','retention_scope','user_data_export_scope') NOT NULL,
  `subjectId` varchar(128) NOT NULL,
  `deleteMode` enum('standard','privacy_request','retention_expiry') NOT NULL,
  `reasonCode` varchar(64) NOT NULL,
  `policyRevisionId` varchar(64),
  `requestedBy` varchar(128) NOT NULL,
  `requestPrincipalKind` enum('user','service') NOT NULL DEFAULT 'user',
  `requestState` enum('planning','blocked_by_hold','deleting','completed','partial','failed','cancelled') NOT NULL DEFAULT 'planning',
  `blockedReasonCodes` text,
  `auditEventId` varchar(36),
  `acceptedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` datetime(3),
  PRIMARY KEY (`id`),
  KEY `V11DeletionRequest_tenant_subject_idx` (`tenantId`, `subjectType`, `subjectId`),
  KEY `V11DeletionRequest_tenant_state_idx` (`tenantId`, `requestState`),
  KEY `V11DeletionRequest_tenant_requested_by_idx` (`tenantId`, `requestedBy`),
  CONSTRAINT `V11DeletionRequest_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE `V11DeletionStep` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `requestId` varchar(36) NOT NULL,
  `storeType` enum('mysql','object_storage','vector_search','trace_log','cache') NOT NULL,
  `subjectRef` varchar(256) NOT NULL,
  `stepState` enum('pending','running','completed','failed','blocked','retained','skipped') NOT NULL DEFAULT 'pending',
  `evidenceRef` varchar(256),
  `failureReason` text,
  `attemptCount` int NOT NULL DEFAULT 0,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` datetime(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `V11DeletionStep_request_store_subject_uq` (`requestId`, `storeType`, `subjectRef`),
  KEY `V11DeletionStep_tenant_request_idx` (`tenantId`, `requestId`),
  KEY `V11DeletionStep_request_state_idx` (`requestId`, `stepState`),
  CONSTRAINT `V11DeletionStep_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11DeletionStep_request_fk` FOREIGN KEY (`requestId`) REFERENCES `V11DeletionRequest` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
