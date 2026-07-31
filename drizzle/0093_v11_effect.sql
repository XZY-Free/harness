-- V11 Stage 8 S08-C05: effect_record / effect_target
--
-- 事实源：lib/v11/schema/effect.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §6.7（effect_record / effect_target）、
--         §6.6（tool_call.call_state 与 effect_state 同步）、§5.5、
--         ../v11-agentkit-platform/11-api-and-event-boundaries.md §5.2（Gateway 即时核对）、§6.5（Admin 长期核对）、
--         ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W05。
--
-- 关键约束：
-- - 一条有副作用 ToolCall 恰有一条 EffectRecord（UNIQUE(toolCallId) 一对一）。
-- - effect_target 通过 UNIQUE(effect_record_id, target_hash) 防止同目标重复记录。
-- - 总 effect_state 由目标明细派生：confirmed_success / confirmed_partial / confirmed_failure / unknown_effect。
-- - 写入后不可变：effect_type / tool_call_id / external_idempotency_key 不可修改；
--   补偿是新的、单独授权 ToolCall，通过 causation 关联原操作，不修改原事实。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
-- - effect_record_id 外键 → V11EffectRecord(id) ON DELETE CASCADE。
CREATE TABLE `V11EffectRecord` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `toolCallId` varchar(36) NOT NULL,
  `effectType` enum('create','update','delete','send','payment','deploy') NOT NULL,
  `targetSummaryJson` json NOT NULL,
  `effectState` enum('not_started','confirmed_success','confirmed_partial','confirmed_failure','unknown_effect') NOT NULL DEFAULT 'not_started',
  `externalIdempotencyKey` varchar(128) NULL,
  `externalResultRef` varchar(512) NULL,
  `verificationMethod` enum('provider_query','callback_evidence','manual_evidence') NULL,
  `verifiedAt` datetime(3) NULL,
  `evidenceJson` json NULL,
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11EffectRecord_toolCall_uq`(`toolCallId`),
  KEY `V11EffectRecord_tenant_toolCall_idx`(`tenantId`,`toolCallId`),
  KEY `V11EffectRecord_tenant_state_idx`(`tenantId`,`effectState`),
  CONSTRAINT `V11EffectRecord_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11EffectTarget` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `effectRecordId` varchar(36) NOT NULL,
  `targetRef` varchar(512) NOT NULL,
  `targetHash` varchar(128) NOT NULL,
  `targetState` enum('confirmed_success','confirmed_failure','unknown') NOT NULL DEFAULT 'unknown',
  `externalResultRef` varchar(512) NULL,
  `verifiedAt` datetime(3) NULL,
  `evidenceJson` json NULL,
  `notes` text NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11EffectTarget_record_targetHash_uq`(`effectRecordId`,`targetHash`),
  KEY `V11EffectTarget_tenant_record_idx`(`tenantId`,`effectRecordId`),
  KEY `V11EffectTarget_tenant_state_idx`(`tenantId`,`targetState`),
  CONSTRAINT `V11EffectTarget_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11EffectTarget_effectRecordId_fk` FOREIGN KEY (`effectRecordId`) REFERENCES `V11EffectRecord`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
