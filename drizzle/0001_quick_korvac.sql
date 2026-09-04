ALTER TABLE `ExecutionBinding` ADD `capabilityCatalogJson` json NOT NULL;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `capabilityCatalogDigest` varchar(71) NOT NULL;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `capabilityCatalogVersion` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `capabilityCatalogSourceRefs` json NOT NULL;--> statement-breakpoint
ALTER TABLE `ExecutionBinding` ADD `capabilityCatalogCreatedAt` datetime(3) NOT NULL;