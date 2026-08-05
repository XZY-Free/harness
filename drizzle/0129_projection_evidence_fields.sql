-- §4.1: RouteEligibilityProjection 添加完整执行证据字段
ALTER TABLE `RouteEligibilityProjection` ADD `agentPublicationRecordId` varchar(36);
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `runtimePublicationRecordId` varchar(36);
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `agentAttestationIds` json;
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `runtimeAttestationIds` json;
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `conformanceRunId` varchar(36);
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `agentArtifactId` varchar(36);
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `runtimeArtifactId` varchar(36);
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `sourceEventId` varchar(36);
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `sourceAggregateVersion` int;
--> statement-breakpoint
ALTER TABLE `RouteEligibilityProjection` ADD `invalidReason` varchar(255);
