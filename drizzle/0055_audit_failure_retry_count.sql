-- P2-10: auditFailureLog 加 retryCount,重放失败 increment,超限(10)移死信删除,防毒丸永久重试 + FIFO 饿死后续。
ALTER TABLE `AuditFailureLog` ADD COLUMN `retryCount` int NOT NULL DEFAULT 0;
