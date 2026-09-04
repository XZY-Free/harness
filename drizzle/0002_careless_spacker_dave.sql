ALTER TABLE `ExecutionBinding` ADD `executionSubjectType` enum('user','service');--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `executionSubjectId` varchar(128);--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `executionSubjectSource` enum('authenticated_user','trusted_service');--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `executionSubjectFrozenAt` datetime(3);--> statement-breakpoint
UPDATE `ExecutionBinding` AS binding
INNER JOIN `Invocation` AS invocation ON invocation.`id` = binding.`invocationId` AND invocation.`tenantId` = binding.`tenantId`
INNER JOIN `Thread` AS thread ON thread.`id` = invocation.`threadId` AND thread.`tenantId` = binding.`tenantId`
SET binding.`executionSubjectType` = 'user',
    binding.`executionSubjectId` = thread.`ownerUserId`,
    binding.`executionSubjectSource` = 'authenticated_user',
    binding.`executionSubjectFrozenAt` = binding.`boundAt`
WHERE binding.`executionSubjectType` IS NULL;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` MODIFY `executionSubjectType` enum('user','service') NOT NULL;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` MODIFY `executionSubjectId` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` MODIFY `executionSubjectSource` enum('authenticated_user','trusted_service') NOT NULL;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` MODIFY `executionSubjectFrozenAt` datetime(3) NOT NULL;
