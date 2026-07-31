-- V11 Stage 9 S09-C01: V11InvocationCommand.commandType 扩展 'cancel' 类型
--
-- 事实源：lib/v11/schema/conversation.ts、
--         docs/solutions/v11-agentkit-platform/10-core-data-model.md §6.10 行 504（InvocationCommand 表）、
--         docs/solutions/v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §9（Child Thread 取消语义）、
--         docs/solutions/v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md S09-W02（Child 取消与 cancel_requested 状态机）。
--
-- 关键约束：
-- - cancel 命令用于请求取消一条 delegate Child Thread 关系（携带 relation_id 与 reason）。
-- - 取消请求 ≠ 已取消：commandState 转换不可逆 queued → dispatched → acknowledged/failed，
--   relation_state 由 active → cancel_requested → cancelled 由 Runtime/应用服务在终态时落库（§9 行 412-417）。
-- - Runtime 拒绝时不能伪造成功（command 标记 failed）。
-- - 已成功副作用不可撤销；cancel 仅影响后续未完成执行。
ALTER TABLE `V11InvocationCommand`
  MODIFY COLUMN `commandType` enum('steer','interrupt','regenerate','resume','cancel') NOT NULL;
