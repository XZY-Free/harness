-- V11 Stage 8 S08-C04: user_action_request
--
-- 事实源：lib/v11/schema/user-action-request.ts、
--         ../v11-agentkit-platform/10-core-data-model.md §6.8（user_action_request 与 grant）、§5.5、
--         ../v11-agentkit-platform/11-api-and-event-boundaries.md §3.18（resolve）、§3.19（auth callback）、§10。
--
-- 关键约束：
-- - 四种 request_type 共用一张表：confirmation / auth / grant / input。
-- - 请求只能解析一次（应用层原子 UPDATE WHERE requestState='pending'）。
-- - auth 类型成功只能来自可信 callback，:resolve 接口仅接受 cancel。
-- - state/nonce 一次性消费，hash 后存储（不存原值）。
-- - expires_at 超时后进入 expired 终态，不可再 resolve。
-- - block 决策不创建本表记录（§10 验收：无可解析 approve 请求）。
-- - item_id 非空时唯一（员工可见 ThreadItem 投影外键）。
-- - 跨租户隔离：所有查询按 tenantId 过滤。
-- - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
CREATE TABLE `V11UserActionRequest` (
  `id` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `threadId` varchar(36) NOT NULL,
  `turnId` varchar(36) NOT NULL,
  `invocationId` varchar(36) NOT NULL,
  `toolCallId` varchar(36) NULL,
  `itemId` varchar(36) NULL,
  `requestType` enum('confirmation','auth','grant','input') NOT NULL,
  `purpose` varchar(64) NULL,
  `requestState` enum('pending','resolved','expired') NOT NULL DEFAULT 'pending',
  `promptJson` json NOT NULL,
  `inputSchemaJson` json NULL,
  `authStateHash` varchar(128) NULL,
  `nonceHash` varchar(128) NULL,
  `expiresAt` datetime(3) NULL,
  `resolution` enum('approve','deny','submit','cancel') NULL,
  `resolvedBy` varchar(36) NULL,
  `resolvedAt` datetime(3) NULL,
  `responseRedactedJson` json NULL,
  `grantId` varchar(36) NULL,
  `versionNo` bigint NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11UserActionRequest_item_id_uq`(`itemId`),
  KEY `V11UserActionRequest_tenant_invocation_state_idx`(`tenantId`,`invocationId`,`requestState`),
  KEY `V11UserActionRequest_tenant_toolCall_idx`(`tenantId`,`toolCallId`),
  KEY `V11UserActionRequest_tenant_state_expires_idx`(`tenantId`,`requestState`,`expiresAt`),
  KEY `V11UserActionRequest_auth_state_hash_idx`(`authStateHash`),
  CONSTRAINT `V11UserActionRequest_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
