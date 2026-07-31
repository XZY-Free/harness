CREATE TABLE `Deployment` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`environment` varchar(64) NOT NULL,
	`commitSha` varchar(64),
	`imageTag` varchar(256),
	`artifactRef` varchar(512),
	`cicdJobId` varchar(128),
	`cicdJobUrl` varchar(512),
	`status` enum('pending','deploying','deployed','failed','rolled_back') NOT NULL DEFAULT 'pending',
	`previousDeploymentId` varchar(36),
	`deployedAt` datetime,
	`rolledBackAt` datetime,
	`errorMessage` text,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `Deployment_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `SecretMount` (
	`id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`scope` enum('thread','project','skill','tool') NOT NULL,
	`scopeRef` varchar(36),
	`keyId` varchar(64) NOT NULL,
	`ciphertext` text NOT NULL,
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	`rotatedAt` datetime,
	CONSTRAINT `SecretMount_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `Deployment_threadId_status_idx` ON `Deployment` (`threadId`,`status`);--> statement-breakpoint
CREATE INDEX `Deployment_threadId_createdAt_idx` ON `Deployment` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `Deployment_environment_idx` ON `Deployment` (`environment`);--> statement-breakpoint
CREATE INDEX `SecretMount_scope_scopeRef_status_idx` ON `SecretMount` (`scope`,`scopeRef`,`status`);--> statement-breakpoint
CREATE INDEX `SecretMount_name_scope_idx` ON `SecretMount` (`name`,`scope`);