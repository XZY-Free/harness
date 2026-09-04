# Batch 04 Evidence

## 元信息

| 项 | 值 |
|---|---|
| Batch | `04` |
| 起点 SHA | `a0f64b258087b3fa3f776834cc051ba853d18278` |
| 终点 SHA | `SELF_COMMIT` |
| 提交标题 | `fix(agent-call): centralize ingress state transitions` |
| 开始时间 | `2026-09-04T06:04:00Z` |
| 结束时间 | `2026-09-04T06:28:24Z` |
| 实施者 | `AI direct implementation` |

## 唯一状态转换入口

- 应用入口为 `transitionAgentCall`，事务内唯一写实现为 `applyAgentCallTransition`。
- `AgentCallStore.updateState`、旧 transition service 和独立 ingress store 已删除；claim 只认领 Attempt，不再伪造 `queued -> running`。
- A2A ingress、同步响应、用户回答恢复、本地取消和 transport failure 均接入统一入口。
- 冻结矩阵只允许 `queued + call.started`、`running + input_required/completed/failed/cancelled`、`waiting_user + user_response_accepted/cancelled`；终态不可重新打开。
- started 前的本地失败只结束 Attempt，AgentCall 仍为 queued；流丢失同样不伪造 `running -> lost`，交由 Batch 05 恢复 Worker 决策。

## Ingress、映射与版本

- 批次逐事件开启独立 MySQL 事务，每条事件重新锁定 Call、Binding、Parent、全部 Attempt 和 Session。
- Ingress 最终结果固定为 `applied | idempotent | rejected | failed_retryable`；业务拒绝写 reason code 并提交，不通过异常回滚。
- 账本记录 `producerSource`、处理前后版本和处理时间；缺失 eventId 使用事件类型、序列和规范化 payload 摘要形成稳定键，同时记协议拒绝。
- started 强制 task/context 齐全；后续按 task 精确定位，或在 context 精确匹配且只有一个活动 Attempt 时推断。
- 旧 Attempt 同终态迟到事件记 idempotent，不覆盖当前 Call；多活动 Attempt 直接拒绝，不默认 Attempt 1。
- 真实状态变化版本 `+1`；仅补全 task/context/session 映射不增加 AgentCall 版本；幂等与拒绝不增加版本。

## Continuation Producer

- 复用 `ControlPlaneOutboxEvent` 和 `ControlPlaneEventDelivery`，没有新建通用任务表。
- `coordinate_user_input`、`resume_parent`、`resume_agent_or_parent` 与状态变化在同一事务写入。
- event key 包含 AgentCall、source version 和 kind；payload 包含 parent Invocation、AgentCall、source version、kind。
- Delivery 初始为 `pending` 且可领取；Ingress 事务不直接调用父 Harness Loop。
- 重复事件返回首次处理结果，不重复创建 Continuation；事务失败时状态和 Continuation 一起回滚。

## Migration

- Migration：`drizzle/0004_agent_call_ingress_authority.sql`。
- 旧 `mapped` 映射为 `applied`，旧未完成 `accepted` 映射为 `failed_retryable`；保留 rejected reason 并回填处理时间。
- 从 Call + Binding 回填供应方范围和版本证据，再收紧 NOT NULL 与新枚举。
- 建立 `(tenantId, producerSource, producerEventId)` 唯一键前先用 CHECK guard 阻断历史重复供应方事件。
- 定向测试通过真实 MySQL 8 容器执行 migration；未连接生产数据库。

## 定向测试

| 命令 | 测试文件 | 测试数 | 退出码 | 结果 |
|---|---:|---:|---:|---|
| `vitest <Batch 04 seven exact files>`（RED） | 1 initial file | 0 | 1 | 预期失败：唯一状态转换模块尚不存在 |
| `vitest <Batch 04 seven exact files>`（GREEN） | 7 | 42 | 0 | PASS |
| `pnpm typecheck` | 全仓类型边界 | 0 | 0 | PASS |
| `biome check <changed TypeScript>` | 本批 TypeScript | 0 | 0 | PASS |
| `git diff --check` | 本批 diff | 0 | 0 | PASS |

## 本批验收

| ID | 结果 | 证据 |
|---|---|---|
| STATE-01 | PASS | 单元矩阵 16 项；数据库覆盖允许、禁止、终态冲突和正式用户恢复 |
| STATE-02 | PASS | 真实变化 +1、映射补全/幂等/拒绝不增版本、并发终态单赢家、逐事件版本证据 |
| ING-01 | PASS | started task/context 齐全成功，缺一/全缺和映射冲突均持久 rejected |
| ING-02 | PASS | task 精确定位、context 唯一推断、多活动拒绝、重试后旧 Attempt 迟到隔离 |
| ING-03 | PASS | eventId 重放、稳定摘要键、拒绝提交、reason 与版本可查询 |
| ING-04 | PASS | 生产接线与 Architecture Gate 检查所有 AgentCall 状态写入口 |
| CONT-PRODUCER | PASS | outbox/delivery 同事务、唯一 source version key、回滚与重复不增殖 |

## 明确未运行

```text
full_test_suite = false
fresh_db_full = false
all_e2e = false
all_builds = false
github_full_ci = false
```

## 偏差

- 未访问生产数据库，未执行云端写操作。
- HR Agent 未在本地启动；本批不需要调用云端 AgentKit。
- Continuation 消费与父 Invocation 恢复属于 Batch 05，本批只完成可靠产生端。

## 工作区

- `git diff --check`：PASS。
- 提交只包含 Batch 04 的状态 Authority、Ingress/Attempt 映射、Continuation producer、Migration、定向测试和证据。
- 提交后工作区要求干净。
