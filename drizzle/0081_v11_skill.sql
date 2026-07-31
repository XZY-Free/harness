-- V11 Stage 6 S06-C01: skill & skill_version（Skill/Capability 与内容寻址缓存）
--
-- 事实源：lib/v11/schema/skill.ts、
--         阶段 6 Skill/Capability 模型（参考 V11Agent / V11AgentRevision 结构）。
--
-- 关键约束：
-- - UNIQUE(tenantId, skillKey)：租户内稳定 key 唯一（skillKey 正则 `^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符，应用层校验）。
-- - UNIQUE(skillId, versionNo)：Skill 内版本号单调递增。
-- - published SkillVersion 业务内容不可修改；只能新建版本。
-- - withdrawn 只阻止新发布或路由，不删除历史引用。
-- - currentVersionId 必须指向同一 Skill 的 published SkillVersion（逻辑外键，应用层校验）。
-- - contentHash 必须以 `sha256:` 前缀存储（应用层校验）。
CREATE TABLE `V11Skill` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `skillKey` varchar(128) NOT NULL,
  `displayName` varchar(256) NOT NULL,
  `description` text NULL,
  `ownerUserId` varchar(36) NOT NULL,
  `lifecycleState` enum('draft','enabled','disabled','retired') NOT NULL DEFAULT 'draft',
  `currentVersionId` varchar(36) NULL,
  `visibilityScope` varchar(32) NOT NULL DEFAULT 'tenant',
  `sourceType` varchar(32) NOT NULL DEFAULT 'local',
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11Skill_tenant_skillKey_uq`(`tenantId`,`skillKey`),
  KEY `V11Skill_tenant_lifecycle_updated_idx`(`tenantId`,`lifecycleState`,`updatedAt`),
  CONSTRAINT `V11Skill_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;--> statement-breakpoint
CREATE TABLE `V11SkillVersion` (
  `id` varchar(36) NOT NULL,
  `skillId` varchar(36) NOT NULL,
  `versionNo` bigint NOT NULL,
  `contentRef` varchar(512) NOT NULL,
  `contentHash` varchar(128) NOT NULL,
  `manifestJson` json NULL,
  `revisionState` enum('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
  `sourceType` varchar(32) NOT NULL DEFAULT 'local',
  `sourceRef` varchar(256) NULL,
  `createdBy` varchar(128) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `publishedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11SkillVersion_skill_versionNo_uq`(`skillId`,`versionNo`),
  KEY `V11SkillVersion_skill_state_idx`(`skillId`,`revisionState`),
  CONSTRAINT `V11SkillVersion_skillId_fk` FOREIGN KEY (`skillId`) REFERENCES `V11Skill`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
