CREATE TABLE `PolicyConfigHistory` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`changed_by` varchar(36) NOT NULL,
	`before_snapshot` text NOT NULL,
	`after_snapshot` text NOT NULL,
	`changed_keys` text,
	`changed_at` datetime NOT NULL,
	CONSTRAINT `PolicyConfigHistory_id` PRIMARY KEY(`id`)
);
