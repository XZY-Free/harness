-- V11 Stage 9 S09-C07: V11WorkspaceWriteLock / V11WorkspaceOverlay / V11WorkspaceMergeConflict
--
-- 事实源：lib/v11/schema/workspace-lock.ts、
--         ../v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §13（并发 Workspace）、
--           §17（调度与资源可靠性——Workspace 写锁）、§18（预算硬上限时副作用先核对）、
--         ../v11-agentkit-platform/10-core-data-model.md §7.1（WorkspaceBinding 不可变）、§5.5（Event 只 INSERT）、§9（事务边界）、
--         ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md S09-W08、S09-C07。
--
-- 关键约束：
-- - Desktop 同路径同时只有一个活跃写锁（应用层 SELECT FOR UPDATE + lock_state=acquired 校验，§13 行 268 禁止后完成者覆盖）。
-- - 写锁有持锁 Invocation + 可选 ThreadRelation，过期或 Invocation lost 时自动释放（reap + revoke）。
-- - Cloud/Git 并行子任务使用 Overlay（git_worktree / cloud_overlay）隔离；Overlay 有独立 location_ref + base_revision_ref。
-- - 合并冲突显式回传父 Agent：禁止后完成者覆盖（§13 行 268）。
-- - 同一父 Binding + 同一 ThreadRelation 同时只能有一个 Overlay。
-- - 写锁/Overlay 状态变化通过 ThreadEvent 记录，不修改旧事件（§5.5）。
-- - 跨租户隔离：所有查询按 tenantId 过滤；tenantId 外键 → Tenant(id) ON DELETE CASCADE。

CREATE TABLE `V11WorkspaceWriteLock` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `workspaceBindingId` varchar(36) NOT NULL,
  `holderInvocationId` varchar(36) NOT NULL,
  `holderRelationId` varchar(36) NULL,
  `pathRef` varchar(512) NOT NULL,
  `pathFingerprint` varchar(128) NOT NULL,
  `lockState` enum('acquired','released','expired','revoked') NOT NULL DEFAULT 'acquired',
  `acquiredAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` datetime(3) NULL,
  `releasedAt` datetime(3) NULL,
  `releaseReasonCode` varchar(64) NULL,
  `versionNo` varchar(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `V11WorkspaceWriteLock_tenant_binding_path_idx` (`tenantId`, `workspaceBindingId`, `pathFingerprint`),
  KEY `V11WorkspaceWriteLock_tenant_holder_idx` (`tenantId`, `holderInvocationId`),
  KEY `V11WorkspaceWriteLock_tenant_state_idx` (`tenantId`, `lockState`),
  KEY `V11WorkspaceWriteLock_tenant_expiry_idx` (`tenantId`, `expiresAt`),
  CONSTRAINT `V11WorkspaceWriteLock_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE,
  CONSTRAINT `V11WorkspaceWriteLock_binding_fk` FOREIGN KEY (`workspaceBindingId`) REFERENCES `V11WorkspaceBinding` (`id`) ON DELETE CASCADE,
  CONSTRAINT `V11WorkspaceWriteLock_invocation_fk` FOREIGN KEY (`holderInvocationId`) REFERENCES `V11Invocation` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11WorkspaceOverlay` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `parentWorkspaceBindingId` varchar(36) NOT NULL,
  `relationId` varchar(36) NOT NULL,
  `overlayType` enum('git_worktree','cloud_overlay') NOT NULL,
  `overlayLocationRef` varchar(512) NOT NULL,
  `overlayFingerprint` varchar(128) NOT NULL,
  `baseRevisionRef` varchar(256) NULL,
  `overlayState` enum('active','merged','conflict','discarded') NOT NULL DEFAULT 'active',
  `taskDescription` text NULL,
  `mergedRevisionRef` varchar(256) NULL,
  `mergedAt` datetime(3) NULL,
  `discardedAt` datetime(3) NULL,
  `versionNo` varchar(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `V11WorkspaceOverlay_tenant_binding_relation_uq` (`tenantId`, `parentWorkspaceBindingId`, `relationId`),
  KEY `V11WorkspaceOverlay_tenant_state_idx` (`tenantId`, `overlayState`),
  KEY `V11WorkspaceOverlay_tenant_relation_idx` (`tenantId`, `relationId`),
  CONSTRAINT `V11WorkspaceOverlay_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE,
  CONSTRAINT `V11WorkspaceOverlay_binding_fk` FOREIGN KEY (`parentWorkspaceBindingId`) REFERENCES `V11WorkspaceBinding` (`id`) ON DELETE CASCADE,
  CONSTRAINT `V11WorkspaceOverlay_relation_fk` FOREIGN KEY (`relationId`) REFERENCES `V11ThreadRelation` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint

CREATE TABLE `V11WorkspaceMergeConflict` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `overlayId` varchar(36) NOT NULL,
  `conflictPathRef` varchar(512) NOT NULL,
  `pathFingerprint` varchar(128) NOT NULL,
  `beforeHash` varchar(128) NULL,
  `oursHash` varchar(128) NULL,
  `theirsHash` varchar(128) NULL,
  `conflictState` enum('reported','resolved','abandoned') NOT NULL DEFAULT 'reported',
  `conflictDetailsJson` json NULL,
  `resolutionSummary` text NULL,
  `reportedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolvedAt` datetime(3) NULL,
  `versionNo` varchar(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `V11WorkspaceMergeConflict_tenant_overlay_idx` (`tenantId`, `overlayId`),
  KEY `V11WorkspaceMergeConflict_tenant_state_idx` (`tenantId`, `conflictState`),
  CONSTRAINT `V11WorkspaceMergeConflict_tenant_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE,
  CONSTRAINT `V11WorkspaceMergeConflict_overlay_fk` FOREIGN KEY (`overlayId`) REFERENCES `V11WorkspaceOverlay` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
