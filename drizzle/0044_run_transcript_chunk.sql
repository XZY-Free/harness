CREATE TABLE `RunTranscriptChunk` (
	`id` varchar(36) NOT NULL,
	`threadId` varchar(36) NOT NULL,
	`runId` varchar(36) NOT NULL,
	`sequence` int NOT NULL,
	`kind` varchar(32) NOT NULL,
	`payload` json NOT NULL,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `RunTranscriptChunk_id` PRIMARY KEY(`id`),
	CONSTRAINT `RunTranscriptChunk_runId_sequence_uq` UNIQUE(`runId`,`sequence`)
);
--> statement-breakpoint
ALTER TABLE `RunTranscriptChunk` ADD CONSTRAINT `RunTranscriptChunk_threadId_Thread_id_fk` FOREIGN KEY (`threadId`) REFERENCES `Thread`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `RunTranscriptChunk` ADD CONSTRAINT `RunTranscriptChunk_runId_ThreadRun_id_fk` FOREIGN KEY (`runId`) REFERENCES `ThreadRun`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `RunTranscriptChunk_runId_sequence_idx` ON `RunTranscriptChunk` (`runId`,`sequence`);