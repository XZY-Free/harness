CREATE TABLE `PermissionGroup` (
	`principalId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`source` varchar(160) NOT NULL DEFAULT 'local',
	`version` int NOT NULL DEFAULT 1,
	CONSTRAINT `PermissionGroup_principalId` PRIMARY KEY(`principalId`)
);
--> statement-breakpoint
CREATE TABLE `PermissionGroupMember` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`groupId` varchar(36) NOT NULL,
	`userId` varchar(36) NOT NULL,
	`validUntil` datetime(3),
	CONSTRAINT `PermissionGroupMember_id` PRIMARY KEY(`id`),
	CONSTRAINT `PermissionGroupMember_uq` UNIQUE(`tenantId`,`groupId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `PermissionRole` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`permissions` json NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	CONSTRAINT `PermissionRole_id` PRIMARY KEY(`id`),
	CONSTRAINT `PermissionRole_tenant_name_uq` UNIQUE(`tenantId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `PermissionRoleAssignment` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`principalId` varchar(36) NOT NULL,
	`roleKey` varchar(96) NOT NULL,
	`source` varchar(128) NOT NULL DEFAULT 'local',
	CONSTRAINT `PermissionRoleAssignment_id` PRIMARY KEY(`id`),
	CONSTRAINT `PermissionRoleAssignment_uq` UNIQUE(`tenantId`,`principalId`,`roleKey`,`source`)
);
--> statement-breakpoint
CREATE TABLE `ResourceAccessPolicy` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`resourceType` varchar(64) NOT NULL,
	`resourceId` varchar(36) NOT NULL,
	`mode` varchar(16) NOT NULL DEFAULT 'inherit',
	`principals` json NOT NULL,
	`collaborators` json NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	CONSTRAINT `ResourceAccessPolicy_id` PRIMARY KEY(`id`),
	CONSTRAINT `ResourceAccessPolicy_resource_uq` UNIQUE(`tenantId`,`resourceType`,`resourceId`)
);
--> statement-breakpoint
ALTER TABLE `PermissionGroup` ADD CONSTRAINT `PermissionGroup_principalId_PrincipalBinding_id_fk` FOREIGN KEY (`principalId`) REFERENCES `PrincipalBinding`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PermissionGroup` ADD CONSTRAINT `PermissionGroup_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PermissionGroupMember` ADD CONSTRAINT `PermissionGroupMember_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PermissionGroupMember` ADD CONSTRAINT `PermissionGroupMember_groupId_PermissionGroup_principalId_fk` FOREIGN KEY (`groupId`) REFERENCES `PermissionGroup`(`principalId`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PermissionRole` ADD CONSTRAINT `PermissionRole_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PermissionRoleAssignment` ADD CONSTRAINT `PermissionRoleAssignment_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `PermissionRoleAssignment` ADD CONSTRAINT `PermissionRoleAssignment_principalId_PrincipalBinding_id_fk` FOREIGN KEY (`principalId`) REFERENCES `PrincipalBinding`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ResourceAccessPolicy` ADD CONSTRAINT `ResourceAccessPolicy_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;