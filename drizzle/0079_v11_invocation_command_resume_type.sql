-- V11 Stage 5 S05-C04: V11InvocationCommand.commandType 扩展 'resume' 类型
--
-- 事实源：lib/v11/schema/conversation.ts、
--         docs/solutions/v11-agentkit-platform/02-agent-thread-and-runtime.md §3.10（Resume）、
--         docs/solutions/v11-agentkit-platform/10-core-data-model.md §6.10 行 504（InvocationCommand 表）
--
-- 关键约束：
-- - resume 命令用于恢复 waiting_user 状态的 Invocation（携带用户响应 resume_payload）。
-- - Runtime 拒绝时不能伪造成功（command 标记 failed，§3.10）。
-- - 已成功副作用不可撤销；Resume 不能新建 continuation Invocation。
-- - commandState 转换不可逆：queued → dispatched → acknowledged/failed。
ALTER TABLE `V11InvocationCommand`
  MODIFY COLUMN `commandType` enum('steer','interrupt','regenerate','resume') NOT NULL;
