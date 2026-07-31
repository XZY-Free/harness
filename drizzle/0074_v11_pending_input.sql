-- V11 Stage 4 S04-C04: pending_input 表（Thread 内待接纳输入队列）
--
-- 事实源：lib/v11/schema/conversation.ts、docs/solutions/v11-agentkit-platform/10-core-data-model.md §5.6 行 324-339
--
-- 关键约束：
-- - UNIQUE(thread_id, client_message_id) 防止客户端重发同 ID 创建重复行。
-- - queue_position DECIMAL(20,10) 用于排序；新创建追加到队尾用 max+1000（首个为 1000）。
-- - input_state=pending 才可编辑/删除/重排；admitted/removed 不可变（§5.6 行 339）。
-- - versionNo 是资源 ETag 来源；Thread.pendingQueueVersionNo 是队列 ETag 来源。
CREATE TABLE `V11PendingInput` (
  `id` varchar(36) NOT NULL,
  `threadId` varchar(36) NOT NULL,
  `clientMessageId` varchar(128) NULL,
  `inputState` enum('pending','admitted','removed') NOT NULL DEFAULT 'pending',
  `queuePosition` decimal(20,10) NOT NULL,
  `inputJson` json NOT NULL,
  `inputHash` varchar(128) NOT NULL,
  `admittedTurnId` varchar(36) NULL,
  `admittedItemId` varchar(36) NULL,
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `removedAt` datetime(3) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11PendingInput_thread_client_message_uq`(`threadId`,`clientMessageId`),
  KEY `V11PendingInput_thread_state_position_idx`(`threadId`,`inputState`,`queuePosition`),
  CONSTRAINT `V11PendingInput_threadId_fk` FOREIGN KEY (`threadId`) REFERENCES `V11Thread`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
