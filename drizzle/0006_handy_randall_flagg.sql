CREATE TABLE `PolicyConfig` (
	`key` varchar(64) NOT NULL,
	`value` json NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `PolicyConfig_key` PRIMARY KEY(`key`)
);

-- Phase 4-4: backfill 默认 policy 配置行（升级即生效；seed 亦可幂等重置）
--> statement-breakpoint
INSERT INTO `PolicyConfig` (`key`, `value`, `updatedAt`) VALUES ('protectedPaths', CAST('["^\\\\.git(\\\\/|$)"]' AS JSON), NOW()) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updatedAt` = NOW();
--> statement-breakpoint
INSERT INTO `PolicyConfig` (`key`, `value`, `updatedAt`) VALUES ('commandDenyList', CAST('["\\\\brm\\\\s+-[a-z]*r[a-z]*f?\\\\s+(\\\\/|~)",":\\\\s*\\\\(\\\\)\\\\s*\\\\{\\\\s*:\\\\s*\\\\|\\\\s*:&\\\\s*\\\\}\\\\s*;\\\\s*:","\\\\bmkfs\\\\.\\\\w+\\\\b","\\\\bdd\\\\b[^|]*\\\\bof=\\\\/dev\\\\/"]' AS JSON), NOW()) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updatedAt` = NOW();
--> statement-breakpoint
INSERT INTO `PolicyConfig` (`key`, `value`, `updatedAt`) VALUES ('formatOnWrite', CAST('{"enabled":true,"command":"npx --no-install prettier --write"}' AS JSON), NOW()) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updatedAt` = NOW();
--> statement-breakpoint
INSERT INTO `PolicyConfig` (`key`, `value`, `updatedAt`) VALUES ('verifyBeforeDelivery', CAST('{"enabled":true,"command":"npm test","timeoutMs":60000,"timeoutIsFailure":false,"testFilePattern":"(^|\\\\/)(__tests__|tests?|spec)\\\\/|\\\\.(test|spec)\\\\.[cm]?[jt]sx?$"}' AS JSON), NOW()) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updatedAt` = NOW();
