CREATE TABLE `AuthSession` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`userIdentityId` varchar(36) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`expiresAt` datetime(3) NOT NULL,
	`revokedAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `AuthSession_id` PRIMARY KEY(`id`),
	CONSTRAINT `AuthSession_token_uq` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `LocalCredential` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`userIdentityId` varchar(36) NOT NULL,
	`normalizedEmail` varchar(254) NOT NULL,
	`passwordHash` varchar(512) NOT NULL,
	`failedLoginCount` int NOT NULL DEFAULT 0,
	`lockedUntil` datetime(3),
	`passwordChangedAt` datetime(3) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `LocalCredential_id` PRIMARY KEY(`id`),
	CONSTRAINT `LocalCredential_tenant_email_uq` UNIQUE(`tenantId`,`normalizedEmail`),
	CONSTRAINT `LocalCredential_user_uq` UNIQUE(`userIdentityId`)
);
--> statement-breakpoint
ALTER TABLE `AuthSession` ADD CONSTRAINT `AuthSession_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `AuthSession` ADD CONSTRAINT `AuthSession_userIdentityId_UserIdentity_id_fk` FOREIGN KEY (`userIdentityId`) REFERENCES `UserIdentity`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `LocalCredential` ADD CONSTRAINT `LocalCredential_tenantId_Tenant_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `LocalCredential` ADD CONSTRAINT `LocalCredential_userIdentityId_UserIdentity_id_fk` FOREIGN KEY (`userIdentityId`) REFERENCES `UserIdentity`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `AuthSession_user_expiry_idx` ON `AuthSession` (`tenantId`,`userIdentityId`,`expiresAt`);