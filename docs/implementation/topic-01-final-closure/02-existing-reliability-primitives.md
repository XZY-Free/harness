# 现有可靠任务基础设施审计

## 候选比较

| 候选 | 持久化 DUR-01 | 同事务写入 DUR-02 | 唯一键 DUR-03 | 多实例租约 DUR-04 | 崩溃重领 DUR-05 | 重试与死信 DUR-06 | 可审计 DUR-07 | 结论 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `ControlPlaneOutboxEvent` + `ControlPlaneEventDelivery` + `outbox-relay-worker` | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 唯一满足全部条件，可表达 continuation 事件 |
| `InvocationAttempt` + runtime-dispatch-retry worker | 是 | 部分 | 是 | 是 | 是 | 是 | 是 | 只表达 Runtime 首次/重试派发，不能承担任意 Invocation 恢复 |
| `HostedProvisioningRequest` worker | 是 | 部分 | 是 | 是 | 是 | 是 | 是 | 专属于 Hosted Runtime provisioning，不在 AgentCall 事务边界 |
| `ExecutionOwnership` | 是 | 是 | 是 | 是 | 是 | 否 | 部分 | 只提供执行租约，不是任务队列 |
| `IdempotencyRecord` | 是 | 是 | 是 | 否 | 否 | 否 | 是 | 只用于请求去重 |

## 事实依据

- Outbox 事件拥有全局唯一 `eventKey`、aggregate/version、payload 与 `availableAt`。
- 每个 consumer 有独立 Delivery，唯一约束为 `(eventId, consumerName)`。
- Delivery 持久保存 pending/running/completed/dead_lettered、attemptCount、nextAttemptAt、lease owner/expiry、错误和完成时间。
- Relay 使用 MySQL `FOR UPDATE SKIP LOCKED` 抢占，能回收过期 lease，并在处理期间续租。
- 现有 repository 已支持在业务事务内 append outbox 与创建 delivery，失败时整体回滚。
- Worker 的成功、重试和 dead-letter 均留在数据库并写审计记录。

## 冻结结论

唯一决策：复用 `ControlPlaneOutboxEvent` + `ControlPlaneEventDelivery`，新增专用的 Invocation Continuation 事件类型和 consumer，不新建另一张通用任务表，也不引入外部消息中间件。

Batch 04 在 AgentCall 状态转换的同一事务内追加 continuation 事件；Batch 05 的专用 consumer 恢复原 Invocation。该 consumer 使用工程包冻结的 8 次有限重试与退避规则，并沿用现有 lease、崩溃回收、幂等投递与 dead-letter 审计能力。同步快速完成路径与 Worker 必须共用 Invocation 执行租约，保证只有一次业务效果。

该选择不是因为命名或技术统一，而是它是唯一同时满足 DUR-01—DUR-07、可在 AgentCall 状态事务内原子产生、且已经具备持久消费状态的现有设施。
