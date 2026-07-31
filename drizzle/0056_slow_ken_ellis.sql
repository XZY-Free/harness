-- V9 内置浏览器与工作区：数据模型（方案 docs/solutions/v9-browser-workspace/00-README.md §五）。
-- 4 张新表：UserBrowserProfile / BrowserSession / BrowserTab / BrowserDownload。
-- 注意：本迁移不包含 Message 索引重命名（0054 已做）和 AuditFailureLog.retryCount（0055 已做）。
CREATE TABLE `BrowserDownload` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`sessionId` varchar(36),
	`tabId` varchar(36),
	`runId` varchar(36),
	`sourceUrl` text,
	`fileName` varchar(255) NOT NULL,
	`workspacePath` varchar(512) NOT NULL,
	`sizeBytes` bigint NOT NULL DEFAULT 0,
	`mimeType` varchar(128),
	`status` enum('downloading','completed','failed','deleted') NOT NULL DEFAULT 'downloading',
	`createdAt` datetime NOT NULL,
	CONSTRAINT `BrowserDownload_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
CREATE TABLE `BrowserSession` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`userId` varchar(36) NOT NULL,
	`mode` enum('profile','incognito') NOT NULL DEFAULT 'profile',
	`status` enum('active','idle','closed','crashed') NOT NULL DEFAULT 'active',
	`activeTabId` varchar(36),
	`lockOwnerRunId` varchar(36),
	`lockExpiresAt` datetime(3),
	`lastActiveAt` datetime(3) NOT NULL,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `BrowserSession_id` PRIMARY KEY(`id`),
	CONSTRAINT `BrowserSession_threadId_uq` UNIQUE(`threadId`)
);--> statement-breakpoint
CREATE TABLE `BrowserTab` (
	`id` varchar(36) NOT NULL,
	`sessionId` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`mode` enum('profile','incognito') NOT NULL DEFAULT 'profile',
	`title` varchar(512),
	`url` text,
	`faviconUrl` text,
	`screenshotRef` text,
	`status` enum('loading','ready','error','closed') NOT NULL DEFAULT 'loading',
	`lastError` text,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `BrowserTab_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
CREATE TABLE `UserBrowserProfile` (
	`id` varchar(36) NOT NULL,
	`userId` varchar(36) NOT NULL,
	`origin` varchar(255) NOT NULL,
	`mode` varchar(16) NOT NULL DEFAULT 'profile',
	`encryptedStateRef` text,
	`stateSummary` json,
	`lastUsedAt` datetime(3) NOT NULL,
	`expiresAt` datetime NOT NULL,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `UserBrowserProfile_id` PRIMARY KEY(`id`),
	CONSTRAINT `UserBrowserProfile_userId_origin_uq` UNIQUE(`userId`,`origin`)
);--> statement-breakpoint
ALTER TABLE `BrowserDownload` ADD CONSTRAINT `BrowserDownload_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `BrowserSession` ADD CONSTRAINT `BrowserSession_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `BrowserSession` ADD CONSTRAINT `BrowserSession_userId_User_id_fk` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `BrowserTab` ADD CONSTRAINT `BrowserTab_sessionId_BrowserSession_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `BrowserSession`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `BrowserTab` ADD CONSTRAINT `BrowserTab_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `UserBrowserProfile` ADD CONSTRAINT `UserBrowserProfile_userId_User_id_fk` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `BrowserDownload_threadId_idx` ON `BrowserDownload` (`threadId`);--> statement-breakpoint
CREATE INDEX `BrowserDownload_sessionId_idx` ON `BrowserDownload` (`sessionId`);--> statement-breakpoint
CREATE INDEX `BrowserDownload_status_idx` ON `BrowserDownload` (`status`);--> statement-breakpoint
CREATE INDEX `BrowserSession_userId_idx` ON `BrowserSession` (`userId`);--> statement-breakpoint
CREATE INDEX `BrowserSession_status_lastActiveAt_idx` ON `BrowserSession` (`status`,`lastActiveAt`);--> statement-breakpoint
CREATE INDEX `BrowserTab_sessionId_idx` ON `BrowserTab` (`sessionId`);--> statement-breakpoint
CREATE INDEX `BrowserTab_threadId_idx` ON `BrowserTab` (`threadId`);--> statement-breakpoint
CREATE INDEX `BrowserTab_status_idx` ON `BrowserTab` (`status`);--> statement-breakpoint
CREATE INDEX `UserBrowserProfile_expiresAt_idx` ON `UserBrowserProfile` (`expiresAt`);
