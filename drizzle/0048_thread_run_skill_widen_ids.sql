-- V8 补充方案阶段 2：放宽 ThreadRunSkill 外部标识长度，支持企业平台 ID。
-- - skillId / skillVersionId: 36 → 128（capability-market sk_* / skv_* 可能超过 36）
-- - contentHash: 40 → 128（企业平台 sha256:<64hex> 总长 71，本地 git sha 仍 40）
ALTER TABLE `ThreadRunSkill` MODIFY COLUMN `skillId` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `ThreadRunSkill` MODIFY COLUMN `skillVersionId` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `ThreadRunSkill` MODIFY COLUMN `contentHash` varchar(128);
