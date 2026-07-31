-- V11 Stage 5 S05-C03: runtime_event_ingress 表（Runtime 回传候选事件持久批次账本）
--
-- 事实源：lib/v11/schema/runtime.ts、
--         docs/solutions/v11-agentkit-platform/10-core-data-model.md §6.9 L486-500
--
-- 关键约束：
-- - UNIQUE(invocationId, producerEventId)：Runtime 稳定事件 id 唯一（幂等键 1）。
-- - UNIQUE(invocationId, producerSequence)：Runtime 连续序号唯一（幂等键 2，整个 Invocation 内连续）。
-- - 相同 producerEventId/producerSequence 但 payloadHash 不同直接拒绝（hash 冲突）。
-- - Runtime 不能指定 Thread/Job event sequence、Item id 或直接更新 Item（平台分配）。
CREATE TABLE `V11RuntimeEventIngress` (
  `id` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `producerEventId` varchar(128) NOT NULL,
  `producerSequence` bigint NOT NULL,
  `candidateType` varchar(64) NOT NULL,
  `schemaVersion` int NOT NULL DEFAULT 1,
  `payloadHash` varchar(128) NOT NULL,
  `payloadJson` json NULL,
  `ingressState` enum('accepted','mapped','rejected') NOT NULL DEFAULT 'accepted',
  `mappedItemId` varchar(36) NULL,
  `mappedThreadEventId` varchar(36) NULL,
  `mappedJobEventId` varchar(36) NULL,
  `receivedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `mappedAt` datetime(3) NULL,
  `rejectedReason` varchar(256) NULL,
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11RuntimeEventIngress_invocation_producer_event_uq`(`invocationId`,`producerEventId`),
  UNIQUE KEY `V11RuntimeEventIngress_invocation_producer_seq_uq`(`invocationId`,`producerSequence`),
  KEY `V11RuntimeEventIngress_invocation_state_idx`(`invocationId`,`ingressState`),
  CONSTRAINT `V11RuntimeEventIngress_invocationId_fk` FOREIGN KEY (`invocationId`) REFERENCES `V11Invocation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11RuntimeEventIngress_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
