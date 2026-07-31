-- V11 Stage 6 S06-C05: tool_call + capability_review（能力调用事实 + 风险差异审核）
--
-- 事实源：lib/v11/schema/tool-call.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §6.6（tool_call）、
--         ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §5（能力变化与审核）、§4.3（Tool 稳定边界）、
--         ../v11-agentkit-platform/12-capability-and-collaboration-api.md §3.2（TOOL_SCHEMA_CHANGED）。
--
-- 关键约束：
-- - UNIQUE(invocationId, callSequence)：Invocation 内 callSequence 单调递增。
-- - UNIQUE(toolId, operationId)：同 Tool + 同 operation_id 幂等。
-- - INDEX(tenantId, invocationId)：按 Invocation 查询调用历史。
-- - INDEX(tenantId, toolId, callState)：按 Tool 统计调用状态。
-- - INDEX(tenantId, reviewState, createdAt)：按审核状态分页查询 pending 列表。
-- - INDEX(tenantId, resourceType, resourceId)：按资源维度查询审核历史。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
-- - invocationId / toolId / itemId 等不加 DB 级 FK，避免跨阶段耦合。
CREATE TABLE `V11ToolCall` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `threadId` varchar(36) NULL,
  `turnId` varchar(36) NULL,
  `jobId` varchar(36) NULL,
  `callSequence` bigint NOT NULL,
  `toolId` varchar(36) NOT NULL,
  `toolSchemaRevisionId` varchar(36) NOT NULL,
  `schemaHash` varchar(128) NOT NULL,
  `callState` varchar(32) NOT NULL DEFAULT 'proposed',
  `operationId` varchar(128) NOT NULL,
  `argumentsRedactedJson` json NOT NULL,
  `argumentsHash` varchar(128) NOT NULL,
  `environmentLeaseId` varchar(36) NULL,
  `resultSummaryJson` json NULL,
  `resultArtifactId` varchar(36) NULL,
  `itemId` varchar(36) NULL,
  `errorCode` varchar(128) NULL,
  `errorSummary` text NULL,
  `startedAt` datetime(3) NULL,
  `finishedAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11ToolCall_invocation_callSequence_uq`(`invocationId`,`callSequence`),
  UNIQUE KEY `V11ToolCall_tool_operationId_uq`(`toolId`,`operationId`),
  KEY `V11ToolCall_tenant_invocation_idx`(`tenantId`,`invocationId`),
  KEY `V11ToolCall_tenant_tool_state_idx`(`tenantId`,`toolId`,`callState`),
  CONSTRAINT `V11ToolCall_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

-- V11 CapabilityReview：能力变化审核请求记录。
-- - resourceType=skill/tool，记录变更前后修订 id 与风险差异类型。
-- - reviewState 状态机：pending → approved/rejected。
-- - requiresReview=true 时必须集中审核通过后才能生效。
CREATE TABLE `V11CapabilityReview` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `resourceType` enum('skill','tool') NOT NULL,
  `resourceId` varchar(36) NOT NULL,
  `oldRevisionId` varchar(36) NULL,
  `newRevisionId` varchar(36) NOT NULL,
  `diffType` varchar(64) NOT NULL,
  `requiresReview` boolean NOT NULL DEFAULT false,
  `description` text NOT NULL,
  `affectedAgentsJson` json NOT NULL,
  `reviewState` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `reviewedBy` varchar(128) NULL,
  `reviewedAt` datetime(3) NULL,
  `reviewNotes` text NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  KEY `V11CapabilityReview_tenant_state_created_idx`(`tenantId`,`reviewState`,`createdAt`),
  KEY `V11CapabilityReview_tenant_resource_idx`(`tenantId`,`resourceType`,`resourceId`),
  CONSTRAINT `V11CapabilityReview_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
