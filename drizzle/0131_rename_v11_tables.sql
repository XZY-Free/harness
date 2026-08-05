-- §4.1: 重建 DB baseline — 移除 V11 物理表名前缀
-- TS schema 已使用无前缀表名，此 migration 对齐物理表名
--
-- 背景：
-- - migration 0062-0110 创建了 83 张 V11 前缀物理表（V11Agent, V11Runtime …）
-- - lib/persistence/schema/*.ts 的 Drizzle 定义使用无前缀表名（mysqlTable("Agent", …)）
-- - 运行时 ORM 查找 "Agent" 但 DB 中是 "V11Agent"，导致表不存在错误
--
-- 冲突处理：
-- 7 张旧表（Agent/Artifact/MemoryEntry/Skill/SkillVersion/Thread/ThreadEvent）
-- 与 V11 目标名同名。开发阶段无生产数据，先 DROP 旧表再 RENAME。
-- 旧表来自 migration 0000-0018（Phase 4-4 旧 schema）和 0113（控制面 Artifact）。
-- V11 版本是新 schema 的事实源，旧表已不再使用。
--
-- FK 处理：
-- 旧表存在被其他表引用的外键约束，开发 baseline 重建期间禁用 FK 检查，
-- RENAME 完成后重新启用。

SET FOREIGN_KEY_CHECKS = 0;
--> statement-breakpoint

-- ─── DROP 与 V11 目标名冲突的旧表 ──────────────────────────
-- 旧 chat-app 表（Agent/MemoryEntry/Skill/SkillVersion/Thread/ThreadEvent）与 V11 目标名同名。
-- 开发阶段无生产数据，先 DROP 旧表再 RENAME。
-- 注意：
-- - V11Artifact 是运行产物表，因控制面已使用 "Artifact" 表名（migration 0113，含 kind 列），
--   改名为 RuntimeArtifact 避免冲突，不 DROP 控制面 Artifact 表。
-- - 旧 chat-app Artifact 表在 migration 0113 时已被控制面 Artifact 表取代（CREATE 替换），
--   不可再 DROP，否则会删除控制面 Artifact 表。
DROP TABLE IF EXISTS `Agent`;
--> statement-breakpoint
DROP TABLE IF EXISTS `MemoryEntry`;
--> statement-breakpoint
DROP TABLE IF EXISTS `Skill`;
--> statement-breakpoint
DROP TABLE IF EXISTS `SkillVersion`;
--> statement-breakpoint
DROP TABLE IF EXISTS `Thread`;
--> statement-breakpoint
DROP TABLE IF EXISTS `ThreadEvent`;
--> statement-breakpoint

-- ─── RENAME V11 前缀表为无前缀版本（83 张） ──────────────────
RENAME TABLE `V11Agent` TO `Agent`;
--> statement-breakpoint
RENAME TABLE `V11AgentRevision` TO `AgentRevision`;
--> statement-breakpoint
RENAME TABLE `V11Artifact` TO `RuntimeArtifact`;
--> statement-breakpoint
RENAME TABLE `V11ArtifactAttestation` TO `ArtifactAttestation`;
--> statement-breakpoint
RENAME TABLE `V11CapabilityReview` TO `CapabilityReview`;
--> statement-breakpoint
RENAME TABLE `V11CapabilityUse` TO `CapabilityUse`;
--> statement-breakpoint
RENAME TABLE `V11CatalogEntry` TO `CatalogEntry`;
--> statement-breakpoint
RENAME TABLE `V11CatalogRevision` TO `CatalogRevision`;
--> statement-breakpoint
RENAME TABLE `V11Connection` TO `Connection`;
--> statement-breakpoint
RENAME TABLE `V11ContextCheckpoint` TO `ContextCheckpoint`;
--> statement-breakpoint
RENAME TABLE `V11CredentialRef` TO `CredentialRef`;
--> statement-breakpoint
RENAME TABLE `V11DeletionRequest` TO `DeletionRequest`;
--> statement-breakpoint
RENAME TABLE `V11DeletionStep` TO `DeletionStep`;
--> statement-breakpoint
RENAME TABLE `V11DeploymentRoute` TO `DeploymentRoute`;
--> statement-breakpoint
RENAME TABLE `V11DeploymentRouteSet` TO `DeploymentRouteSet`;
--> statement-breakpoint
RENAME TABLE `V11EffectRecord` TO `EffectRecord`;
--> statement-breakpoint
RENAME TABLE `V11EffectTarget` TO `EffectTarget`;
--> statement-breakpoint
RENAME TABLE `V11EnvironmentChangeRequest` TO `EnvironmentChangeRequest`;
--> statement-breakpoint
RENAME TABLE `V11EnvironmentDefinition` TO `EnvironmentDefinition`;
--> statement-breakpoint
RENAME TABLE `V11EnvironmentLease` TO `EnvironmentLease`;
--> statement-breakpoint
RENAME TABLE `V11EventDeliveryFailure` TO `EventDeliveryFailure`;
--> statement-breakpoint
RENAME TABLE `V11EventStreamFloor` TO `EventStreamFloor`;
--> statement-breakpoint
RENAME TABLE `V11ExecutionBinding` TO `ExecutionBinding`;
--> statement-breakpoint
RENAME TABLE `V11ExecutionOwnership` TO `ExecutionOwnership`;
--> statement-breakpoint
RENAME TABLE `V11FileChange` TO `FileChange`;
--> statement-breakpoint
RENAME TABLE `V11FilesystemCheckpoint` TO `FilesystemCheckpoint`;
--> statement-breakpoint
RENAME TABLE `V11Goal` TO `Goal`;
--> statement-breakpoint
RENAME TABLE `V11Grant` TO `Grant`;
--> statement-breakpoint
RENAME TABLE `V11IncidentContainment` TO `IncidentContainment`;
--> statement-breakpoint
RENAME TABLE `V11Invocation` TO `Invocation`;
--> statement-breakpoint
RENAME TABLE `V11InvocationAttempt` TO `InvocationAttempt`;
--> statement-breakpoint
RENAME TABLE `V11InvocationCommand` TO `InvocationCommand`;
--> statement-breakpoint
RENAME TABLE `V11Job` TO `Job`;
--> statement-breakpoint
RENAME TABLE `V11JobCommand` TO `JobCommand`;
--> statement-breakpoint
RENAME TABLE `V11JobEvent` TO `JobEvent`;
--> statement-breakpoint
RENAME TABLE `V11JobResultProjection` TO `JobResultProjection`;
--> statement-breakpoint
RENAME TABLE `V11KnowledgeBase` TO `KnowledgeBase`;
--> statement-breakpoint
RENAME TABLE `V11KnowledgeChunk` TO `KnowledgeChunk`;
--> statement-breakpoint
RENAME TABLE `V11KnowledgeDocument` TO `KnowledgeDocument`;
--> statement-breakpoint
RENAME TABLE `V11KnowledgeDocumentRevision` TO `KnowledgeDocumentRevision`;
--> statement-breakpoint
RENAME TABLE `V11KnowledgeIndex` TO `KnowledgeIndex`;
--> statement-breakpoint
RENAME TABLE `V11LegalHold` TO `LegalHold`;
--> statement-breakpoint
RENAME TABLE `V11MemoryCandidate` TO `MemoryCandidate`;
--> statement-breakpoint
RENAME TABLE `V11MemoryEntry` TO `MemoryEntry`;
--> statement-breakpoint
RENAME TABLE `V11MemoryIndex` TO `MemoryIndex`;
--> statement-breakpoint
RENAME TABLE `V11MemorySource` TO `MemorySource`;
--> statement-breakpoint
RENAME TABLE `V11PendingInput` TO `PendingInput`;
--> statement-breakpoint
RENAME TABLE `V11PermissionDecision` TO `PermissionDecision`;
--> statement-breakpoint
RENAME TABLE `V11Policy` TO `Policy`;
--> statement-breakpoint
RENAME TABLE `V11PolicyRevision` TO `PolicyRevision`;
--> statement-breakpoint
RENAME TABLE `V11PolicySet` TO `PolicySet`;
--> statement-breakpoint
RENAME TABLE `V11ProjectionCheckpoint` TO `ProjectionCheckpoint`;
--> statement-breakpoint
RENAME TABLE `V11RecoveryDrill` TO `RecoveryDrill`;
--> statement-breakpoint
RENAME TABLE `V11RecoveryDrillCheck` TO `RecoveryDrillCheck`;
--> statement-breakpoint
RENAME TABLE `V11RetentionPolicy` TO `RetentionPolicy`;
--> statement-breakpoint
RENAME TABLE `V11Runtime` TO `Runtime`;
--> statement-breakpoint
RENAME TABLE `V11RuntimeConformanceResult` TO `RuntimeConformanceResult`;
--> statement-breakpoint
RENAME TABLE `V11RuntimeEventIngress` TO `RuntimeEventIngress`;
--> statement-breakpoint
RENAME TABLE `V11RuntimeRevision` TO `RuntimeRevision`;
--> statement-breakpoint
RENAME TABLE `V11RuntimeSessionBinding` TO `RuntimeSessionBinding`;
--> statement-breakpoint
RENAME TABLE `V11SecurityIncident` TO `SecurityIncident`;
--> statement-breakpoint
RENAME TABLE `V11Skill` TO `Skill`;
--> statement-breakpoint
RENAME TABLE `V11SkillVersion` TO `SkillVersion`;
--> statement-breakpoint
RENAME TABLE `V11Thread` TO `Thread`;
--> statement-breakpoint
RENAME TABLE `V11ThreadEvent` TO `ThreadEvent`;
--> statement-breakpoint
RENAME TABLE `V11ThreadItem` TO `ThreadItem`;
--> statement-breakpoint
RENAME TABLE `V11ThreadListProjection` TO `ThreadListProjection`;
--> statement-breakpoint
RENAME TABLE `V11ThreadRelation` TO `ThreadRelation`;
--> statement-breakpoint
RENAME TABLE `V11Tool` TO `Tool`;
--> statement-breakpoint
RENAME TABLE `V11ToolCall` TO `ToolCall`;
--> statement-breakpoint
RENAME TABLE `V11ToolProvider` TO `ToolProvider`;
--> statement-breakpoint
RENAME TABLE `V11ToolSchemaRevision` TO `ToolSchemaRevision`;
--> statement-breakpoint
RENAME TABLE `V11Turn` TO `Turn`;
--> statement-breakpoint
RENAME TABLE `V11TurnTimelineProjection` TO `TurnTimelineProjection`;
--> statement-breakpoint
RENAME TABLE `V11UserActionRequest` TO `UserActionRequest`;
--> statement-breakpoint
RENAME TABLE `V11WorkloadTokenRevocation` TO `WorkloadTokenRevocation`;
--> statement-breakpoint
RENAME TABLE `V11Workspace` TO `Workspace`;
--> statement-breakpoint
RENAME TABLE `V11WorkspaceAttachment` TO `WorkspaceAttachment`;
--> statement-breakpoint
RENAME TABLE `V11WorkspaceAttachmentUse` TO `WorkspaceAttachmentUse`;
--> statement-breakpoint
RENAME TABLE `V11WorkspaceBinding` TO `WorkspaceBinding`;
--> statement-breakpoint
RENAME TABLE `V11WorkspaceMergeConflict` TO `WorkspaceMergeConflict`;
--> statement-breakpoint
RENAME TABLE `V11WorkspaceOverlay` TO `WorkspaceOverlay`;
--> statement-breakpoint
RENAME TABLE `V11WorkspaceWriteLock` TO `WorkspaceWriteLock`;
--> statement-breakpoint

SET FOREIGN_KEY_CHECKS = 1;
