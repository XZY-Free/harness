-- P2-6: ThreadRun.status varchar(32) → ENUM,与其他表 status enum 对齐,DB 级取值约束
ALTER TABLE `ThreadRun` MODIFY COLUMN `status` ENUM('queued','running','awaiting_approval','completed','failed','cancelled','stale') NOT NULL DEFAULT 'queued';
