CREATE TABLE `Role` (
	`id` varchar(36) NOT NULL,
	`key` varchar(32) NOT NULL,
	`name` varchar(64) NOT NULL,
	`isSystem` boolean NOT NULL DEFAULT false,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `Role_id` PRIMARY KEY(`id`),
	CONSTRAINT `Role_key_uq` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `RolePermission` (
	`roleId` varchar(36) NOT NULL,
	`permission` varchar(64) NOT NULL,
	CONSTRAINT `RolePermission_roleId_permission_uq` UNIQUE(`roleId`,`permission`)
);
--> statement-breakpoint
CREATE TABLE `UserRole` (
	`userId` varchar(36) NOT NULL,
	`roleId` varchar(36) NOT NULL,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `UserRole_userId_roleId_uq` UNIQUE(`userId`,`roleId`)
);
--> statement-breakpoint
ALTER TABLE `RolePermission` ADD CONSTRAINT `RolePermission_roleId_Role_id_fk` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `UserRole` ADD CONSTRAINT `UserRole_userId_User_id_fk` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `UserRole` ADD CONSTRAINT `UserRole_roleId_Role_id_fk` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE no action ON UPDATE no action;