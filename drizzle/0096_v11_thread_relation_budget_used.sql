-- V11 Stage 9 S09-C02: V11ThreadRelation 增加 budgetUsedJson 字段
--
-- 事实源：lib/v11/schema/conversation.ts、
--         docs/solutions/v11-agentkit-platform/05-continuity-collaboration-and-reliability.md
--           §9 行 398-402（budget policy）、§16 行 590-595（预算硬上限）、§18 行 352-362（共享父预算）、
--         docs/solutions/v11-agentkit-platform/12-capability-and-collaboration-api.md
--           §4.2 行 233-263（budget_used 字段：tokens/cost/tool_calls）、
--         docs/solutions/v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md
--           S09-W02（Child 结果投影、取消与预算）、S09-W08（共享预算上限）。
--
-- 关键约束：
-- - budgetUsedJson 累积子 Thread 实际用量（tokens/cost/tool_calls/wall_clock_ms），
--   与 budgetPolicyJson（上限）分离存储。
-- - 预算耗尽时由应用服务发出 cancel command（reason_code=BUDGET_EXHAUSTED），
--   不在仓储层硬性阻断（避免覆盖 Runtime 调度）。
-- - unknown_effect 标记子 Thread 存在未确认副作用；finalizeChildThreadCancellation
--   接受 unknownEffect 参数并在 child_thread.cancelled Event payload 中显式标记，
--   不把关系伪造成无副作用取消（05 文档 §16 行 333）。
ALTER TABLE `V11ThreadRelation`
  ADD COLUMN `budgetUsedJson` json NULL AFTER `budgetPolicyJson`;
