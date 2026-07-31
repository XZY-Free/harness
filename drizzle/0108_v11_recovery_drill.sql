-- S12-W08：备份恢复演练与一致性核对表。
--
-- 事实源：12-production-operations-security-and-data-lifecycle.md §8
--         （数据库备份、对象版本/复制、配置和密钥恢复分别定义 RPO/RTO 与责任边界；
--           恢复演练验证 Event sequence、投影 checkpoint、Artifact 引用、Legal Hold 和删除证据的一致性；
--           Runtime/Worker/队列故障演练覆盖未完成 ToolCall、unknown Effect、Job 恢复和 UserAction 等待；
--           演练在隔离环境使用真实组件，不连接生产数据库，不以备份任务成功日志代替可恢复性）。
--
-- 变更：
-- 1. 新建 V11RecoveryDrill 表：恢复演练主体。记录演练类型/RPO/RTO 目标/执行人/状态机/一致性汇总/审计事件 id。
--    drillState 推进：scheduled → running → completed / failed / cancelled。
-- 2. 新建 V11RecoveryDrillCheck 表：每次演练下的一致性检查项。按 (drillId, checkType) 唯一。
--    passed/failed 要求 evidenceRef（存储端证据，不能用日志文本冒充）。
-- 3. 不写 ThreadEvent，只写管理域 AuditEvent（recovery.drill）。
-- 4. 演练不连接生产数据库：environmentTag 标识隔离环境。

CREATE TABLE `V11RecoveryDrill` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `drillType` enum('db_restore','object_version','secret_restore','runtime_failover','queue_failover') NOT NULL,
  `drillState` enum('scheduled','running','completed','failed','cancelled') NOT NULL DEFAULT 'scheduled',
  `rpoTargetSeconds` int NOT NULL,
  `rtoTargetSeconds` int NOT NULL,
  `rpoActualSeconds` int,
  `rtoActualSeconds` int,
  `environmentTag` varchar(128) NOT NULL,
  `reason` text,
  `executedBy` varchar(128) NOT NULL,
  `executedByKind` enum('user','service') NOT NULL DEFAULT 'user',
  `consistencySummaryJson` text,
  `auditEventId` varchar(36),
  `failureReason` text,
  `requestId` varchar(64),
  `scheduledAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `startedAt` datetime(3),
  `completedAt` datetime(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `V11RecoveryDrill_tenant_scheduled_idx` (`tenantId`, `scheduledAt`),
  KEY `V11RecoveryDrill_tenant_state_idx` (`tenantId`, `drillState`),
  KEY `V11RecoveryDrill_tenant_type_idx` (`tenantId`, `drillType`),
  KEY `V11RecoveryDrill_tenant_executed_by_idx` (`tenantId`, `executedBy`),
  CONSTRAINT `V11RecoveryDrill_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE `V11RecoveryDrillCheck` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `drillId` varchar(36) NOT NULL,
  `checkType` enum('event_sequence','projection_checkpoint','artifact_ref','legal_hold','deletion_evidence','tool_call_pending','unknown_effect','job_recovery','user_action_wait') NOT NULL,
  `checkState` enum('pending','running','passed','failed','skipped') NOT NULL DEFAULT 'pending',
  `evidenceRef` varchar(256),
  `detailsJson` text,
  `failureReason` text,
  `durationMs` int,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` datetime(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `V11RecoveryDrillCheck_drill_check_uq` (`drillId`, `checkType`),
  KEY `V11RecoveryDrillCheck_tenant_drill_idx` (`tenantId`, `drillId`),
  KEY `V11RecoveryDrillCheck_drill_state_idx` (`drillId`, `checkState`),
  CONSTRAINT `V11RecoveryDrillCheck_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11RecoveryDrillCheck_drill_fk` FOREIGN KEY (`drillId`) REFERENCES `V11RecoveryDrill` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
