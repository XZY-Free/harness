CREATE TABLE `Agent` (
	`id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`description` text,
	`model` varchar(128) NOT NULL,
	`skillId` varchar(36),
	`config` json NOT NULL,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `Agent_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ProviderProfile` (
	`id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`baseUrl` varchar(255) NOT NULL,
	`apiKeyRef` varchar(128) NOT NULL,
	`isDefault` boolean NOT NULL DEFAULT false,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `ProviderProfile_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `Agent` ADD CONSTRAINT `Agent_skillId_Skill_id_fk` FOREIGN KEY (`skillId`) REFERENCES `Skill`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Phase 4-4 切片 B1：回填 2 个新只读权限（agent.read / provider.read）到 admin / member 角色。
-- 幂等：ON DUPLICATE KEY UPDATE 命中唯一索引 (roleId, permission) 时 no-op。
-- 仅回填权限行；运行环境档案（provider/agent 镜像）由 seed 负责，migration 不读取 env。
INSERT INTO `RolePermission` (`roleId`, `permission`)
  SELECT r.id, 'agent.read' FROM `Role` r WHERE r.`key` = 'admin'
  UNION SELECT r.id, 'provider.read' FROM `Role` r WHERE r.`key` = 'admin'
  UNION SELECT r.id, 'agent.read' FROM `Role` r WHERE r.`key` = 'member'
  UNION SELECT r.id, 'provider.read' FROM `Role` r WHERE r.`key` = 'member'
ON DUPLICATE KEY UPDATE `permission` = VALUES(`permission`);