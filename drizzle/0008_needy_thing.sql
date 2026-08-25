ALTER TABLE `ExecutionBinding` ADD `runtimeTargetDigest` varchar(71) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `runtimeTargetDigest` varchar(71);