ALTER TABLE `Thread` ADD `promptTokens` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `Thread` ADD `completionTokens` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `Thread` ADD `totalTokens` int DEFAULT 0 NOT NULL;