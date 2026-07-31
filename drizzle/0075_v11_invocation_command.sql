-- V11 Stage 4 S04-C06: v11_invocation_command 表（Steer/Interrupt/Regenerate 命令入队）
--
-- 事实源：lib/v11/schema/conversation.ts、
--         docs/solutions/v11-agentkit-platform/10-core-data-model.md §6.10 行 504、
--         docs/solutions/v11-agentkit-platform/02-agent-thread-and-runtime.md §3.7（Steer）、§3.8（Stop/Interrupt）、§3.9（Regenerate）
--
-- 关键约束：
-- - command_state=queued 时 invocation_id 可空（Runtime 拉取后才绑定）。
-- - UNIQUE(thread_id, idempotency_key) 防止同 Thread 内重发同 Idempotency-Key。
-- - Runtime 拒绝时不能伪造成功（command 标记 failed，§3.7 行 366）。
-- - 本阶段 Runtime 未接入：所有命令停留在 queued，不模拟 Runtime ack。
CREATE TABLE `V11InvocationCommand` (
  `id` varchar(36) NOT NULL,
  `invocationId` varchar(36) NULL,
  `threadId` varchar(36) NOT NULL,
  `turnId` varchar(36) NULL,
  `commandType` enum('steer','interrupt','regenerate') NOT NULL,
  `commandPayloadJson` json NOT NULL,
  `commandPayloadHash` varchar(128) NOT NULL,
  `commandState` enum('queued','dispatched','acknowledged','failed','cancelled') NOT NULL DEFAULT 'queued',
  `runtimeExecutionRef` varchar(256) NULL,
  `idempotencyKey` varchar(128) NULL,
  `errorCode` varchar(128) NULL,
  `errorMessage` text NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `dispatchedAt` datetime(3) NULL,
  `acknowledgedAt` datetime(3) NULL,
  `failedAt` datetime(3) NULL,
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11InvocationCommand_thread_idempotency_uq`(`threadId`,`idempotencyKey`),
  KEY `V11InvocationCommand_thread_turn_idx`(`threadId`,`turnId`),
  KEY `V11InvocationCommand_invocation_idx`(`invocationId`),
  CONSTRAINT `V11InvocationCommand_threadId_fk` FOREIGN KEY (`threadId`) REFERENCES `V11Thread`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
