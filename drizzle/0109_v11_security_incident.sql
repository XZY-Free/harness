-- S12-W09：安全事件与隔离止损表。
--
-- 事实源：12-production-operations-security-and-data-lifecycle.md §9
--         （安全事件可按 Agent、Revision、ToolProvider、Credential、Runtime 或 Environment 隔离和止损；
--           撤销 Credential、禁用能力或隔离 Route 后，新操作立即拒绝；进行中副作用进入核对而非静默重试；
--           事故时间线从 Audit/Event/Trace 汇总，诊断内容访问仍受时限、脱敏和审计约束）。
--
-- 变更：
-- 1. 新建 V11SecurityIncident 表：安全事件主体。记录严重程度/状态机/目标类型/检测来源/审计事件 id。
--    incidentState 推进：open → investigating → contained → resolved / escalated。
-- 2. 新建 V11IncidentContainment 表：每次事故下的隔离止损动作。按 (incidentId, actionType) 唯一。
--    actionState：pending → applied → reverted（resolved 时可回滚）。
--    applied 要求 evidenceRef（存储端证据，不能用日志文本冒充隔离成功）。
-- 3. 不写 ThreadEvent，只写管理域 AuditEvent（security.incident）。
-- 4. 撤销立即生效：containment applied 后新操作立即拒绝；进行中副作用进入 Effect 核对账本。

CREATE TABLE `V11SecurityIncident` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `incidentKey` varchar(128) NOT NULL,
  `severity` enum('low','medium','high','critical') NOT NULL,
  `incidentState` enum('open','investigating','contained','resolved','escalated') NOT NULL DEFAULT 'open',
  `targetType` enum('agent','agent_revision','tool_provider','tool','credential','runtime','environment','workload_token','other') NOT NULL,
  `targetId` varchar(128) NOT NULL,
  `summary` text,
  `detectedBy` varchar(64) NOT NULL,
  `detectedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `investigatingAt` datetime(3),
  `containedAt` datetime(3),
  `resolvedAt` datetime(3),
  `closedBy` varchar(128),
  `closureReason` text,
  `containmentSummaryJson` text,
  `auditEventId` varchar(36),
  `requestId` varchar(64),
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `V11SecurityIncident_tenant_key_uq` (`tenantId`, `incidentKey`),
  KEY `V11SecurityIncident_tenant_state_idx` (`tenantId`, `incidentState`),
  KEY `V11SecurityIncident_tenant_target_idx` (`tenantId`, `targetType`, `targetId`),
  KEY `V11SecurityIncident_tenant_severity_idx` (`tenantId`, `severity`),
  KEY `V11SecurityIncident_tenant_detected_idx` (`tenantId`, `detectedAt`),
  CONSTRAINT `V11SecurityIncident_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE `V11IncidentContainment` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `incidentId` varchar(36) NOT NULL,
  `actionType` enum('revoke_credential','disable_tool_provider','disable_tool','disable_route','withdraw_agent_revision','withdraw_runtime_revision','revoke_workload_token','isolate_environment','quarantine_event') NOT NULL,
  `actionState` enum('pending','applied','failed','reverted') NOT NULL DEFAULT 'pending',
  `evidenceRef` varchar(256),
  `targetRef` varchar(256),
  `detailsJson` text,
  `failureReason` text,
  `appliedAt` datetime(3),
  `revertedAt` datetime(3),
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `V11IncidentContainment_incident_action_uq` (`incidentId`, `actionType`),
  KEY `V11IncidentContainment_tenant_incident_idx` (`tenantId`, `incidentId`),
  KEY `V11IncidentContainment_incident_state_idx` (`incidentId`, `actionState`),
  CONSTRAINT `V11IncidentContainment_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11IncidentContainment_incident_fk` FOREIGN KEY (`incidentId`) REFERENCES `V11SecurityIncident` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
