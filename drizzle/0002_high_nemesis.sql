ALTER TABLE `DeploymentRouteSet` MODIFY COLUMN `agentId` varchar(36);--> statement-breakpoint
ALTER TABLE `DeploymentRoute` MODIFY COLUMN `agentRevisionId` varchar(36);--> statement-breakpoint
ALTER TABLE `ExecutionBinding` MODIFY COLUMN `agentRevisionId` varchar(36);--> statement-breakpoint
ALTER TABLE `RouteRevision` MODIFY COLUMN `agentRevisionId` varchar(36);--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` MODIFY COLUMN `agentId` varchar(36);--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` MODIFY COLUMN `agentRevisionId` varchar(36);