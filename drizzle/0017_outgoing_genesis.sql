ALTER TABLE `ContextSnapshot` ADD `compressed` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ContextSnapshot` ADD `afterTokens` int;