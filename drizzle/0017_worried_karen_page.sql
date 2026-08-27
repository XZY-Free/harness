ALTER TABLE `InvocationCommand` ADD `dispatchAttemptCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `InvocationCommand` ADD `nextDispatchAt` datetime(3);--> statement-breakpoint
ALTER TABLE `InvocationCommand` ADD `dispatchLeaseOwner` varchar(128);--> statement-breakpoint
ALTER TABLE `InvocationCommand` ADD `dispatchLeaseExpiresAt` datetime(3);--> statement-breakpoint
ALTER TABLE `InvocationCommand` ADD `lastDispatchAttemptAt` datetime(3);--> statement-breakpoint
ALTER TABLE `InvocationCommand` ADD `lastTransientErrorCode` varchar(128);--> statement-breakpoint
ALTER TABLE `InvocationAttempt` ADD `dispatchAttemptCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `InvocationAttempt` ADD `nextDispatchAt` datetime(3);--> statement-breakpoint
ALTER TABLE `InvocationAttempt` ADD `dispatchLeaseOwner` varchar(128);--> statement-breakpoint
ALTER TABLE `InvocationAttempt` ADD `dispatchLeaseExpiresAt` datetime(3);--> statement-breakpoint
ALTER TABLE `InvocationAttempt` ADD `lastDispatchAttemptAt` datetime(3);--> statement-breakpoint
ALTER TABLE `InvocationAttempt` ADD `lastTransientErrorCode` varchar(128);--> statement-breakpoint
CREATE INDEX `InvocationCommand_dispatch_retry_idx` ON `InvocationCommand` (`commandState`,`nextDispatchAt`);--> statement-breakpoint
CREATE INDEX `InvocationCommand_dispatch_lease_idx` ON `InvocationCommand` (`dispatchLeaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `InvocationAttempt_dispatch_retry_idx` ON `InvocationAttempt` (`attemptState`,`nextDispatchAt`);--> statement-breakpoint
CREATE INDEX `InvocationAttempt_dispatch_lease_idx` ON `InvocationAttempt` (`dispatchLeaseExpiresAt`);