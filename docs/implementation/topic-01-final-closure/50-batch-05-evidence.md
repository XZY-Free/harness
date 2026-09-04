# Batch 05 Evidence

## 元信息

| 项 | 值 |
|---|---|
| Batch | `05` |
| 起点 SHA | `f4969090928c7918c48e2331da2714e37c7649cb` |
| 终点 SHA | `SELF_COMMIT` |
| 提交标题 | `feat(runtime): resume harness from durable agent continuations` |
| 开始时间 | `2026-09-04T06:30:00Z` |
| 结束时间 | `2026-09-04T07:04:03Z` |
| 实施者 | `AI direct implementation` |

## Durable Continuation Worker

- 继续复用 `ControlPlaneOutboxEvent` 与 `ControlPlaneEventDelivery`，正式消费者为 `invocation_continuation`。
- Worker 使用 60 秒数据库 Delivery 租约并每 30 秒续租；同一 Delivery 只有持有 `lockedBy` 的 Worker 可以完成、重试、续租或转死信。
- 最大尝试次数固定为 8；退避固定为 `1s / 5s / 30s / 2m / 10m / 30m / 2h / 6h`，不使用随机抖动。
- 不可重试的租户/父级不一致、Binding 缺失、目录损坏、主体不一致、Attempt 歧义和非法状态直接进入 dead-letter。
- dead-letter 前写高优先级 Canonical AuditEvent，并用 `execution.failed` 把未终态父 Invocation/Turn 收口为可诊断失败与人工处理状态。
- 正式 `control-plane-outbox-worker` 进程同时启动 Route Projection 与 Continuation 两个消费者；不依赖 HTTP 请求或开发热重载。

## Resume Harness Invocation

- `createResumeHarnessInvocation` 是唯一父 Harness 恢复应用能力；生产实例为 `resumeHarnessInvocation`。
- 每次恢复重新读取原 Invocation、不可变 ExecutionBinding、RuntimeRevision；从 Binding 恢复 trusted subject，并验证冻结 Capability Catalog 摘要和 invocationId。
- 父级已终态返回 handled-no-op；父级仍等待用户或执行租约被占用时返回可重试错误，不新建 Invocation。
- `ExecutionOwnership` 作为 Harness 执行租约：真实 MySQL 验证新鲜租约拒绝第二 owner，60 秒过期后旧 owner 标记 lost 并以递增 epoch 重领。
- 首次 Hosted Loop 同样持有、续租并释放该执行租约，避免快速 Agent 终态时原 Loop 与 Worker 双跑。
- Hosted 路径从持久行动历史恢复 started `agent.call`；现有 AgentCall 终态由生产执行器转为 Agent Observation，然后继续同一个 Harness Loop。
- failed/cancelled/lost AgentCall 以结构化 Observation 交回 Harness，不直接把父 Invocation 当成子调用终态。
- External Runtime 路径向冻结 endpoint 发送同一 invocationId 的 resume，请求幂等键绑定 AgentCall 与 source version；不创建 continuation Invocation。
- Hosted Adapter `handleResume` 保存并重建同一 Invocation 的 Loop 参数，实际等待 `loop.run()` 结果，不再只返回 ACK。

## waiting_user 与用户回答

- AgentActionExecutor 已删除 `try/catch + warn` 的 best-effort 协调；`coordinate_user_input` 只由持久 Continuation 驱动。
- input-required 使用稳定 Agent ingress 事件 ID 创建/复用唯一 UserActionRequest，并由既有 Event Ingress 同事务协调父 Invocation 与 Turn。
- Agent 用户回答解析事务把脱敏回答、UAR resolved、父状态、已确认的占位 RuntimeCommand，以及 `resume_agent_after_user_response` Outbox 一起提交。
- HTTP resolve 路由不再同步抢跑外部 Agent 或父 Runtime；Worker 从已解析 UAR 恢复 trusted subject，并调用同一 AgentCall、AgentSessionBinding、Attempt task/context。
- Agent 接受回答后，唯一状态服务执行 `waiting_user -> running` 并产生后续 Continuation；最终 Agent 事件仍走 AgentCall Event Ingress。
- 相同 HTTP 幂等键由既有 IdempotencyRecord 返回首次响应；冲突内容仍由既有请求摘要门禁拒绝。

## 定向测试

| 命令 | 测试文件 | 测试数 | 退出码 | 结果 |
|---|---:|---:|---:|---|
| `vitest hosted-adapter-resume.integration`（RED） | 1 | 1 | 1 | 预期失败：`handleResume` 未运行 Loop |
| `vitest <Batch 05 eight exact files>`（GREEN） | 8 | 24 | 0 | PASS |
| `pnpm typecheck` | 全仓类型边界 | 0 | 0 | PASS |
| `biome check <changed TypeScript>` | 本批 TypeScript | 0 | 0 | PASS |
| `git diff --check` | 本批 diff | 0 | 0 | PASS |

## 本批验收

| ID | 结果 | 证据 |
|---|---|---|
| CONT-01 | PASS | 终态 Continuation 恢复原父 Invocation，Hosted 恢复真实运行 Loop 并生成 Observation |
| CONT-02 | PASS | completed/failed/cancelled/lost 均不直接完成父级；失败类结果成为结构化 Observation |
| CONT-03 | PASS | Outbox/Delivery 持久化；过期 Delivery 与 Invocation 执行租约均可重领 |
| CONT-04 | PASS | source version 幂等、旧版本 no-op、父终态 no-op、新鲜执行租约拒绝并发 |
| WAIT-01 | PASS | waiting_user 只由可重试 Continuation 协调；无 warn 后继续路径 |
| WAIT-02 | PASS | 用户回答先持久化 durable Agent resume，恢复同一 call/task/context 与 trusted subject |
| CONT-05 | PASS | 固定 8 次/退避表；永久错误立即死信；死信审计并收口父任务 |
| RESUME-01 | PASS | Hosted 真正运行 Loop；External 复用同一 Invocation；正式 Worker bootstrap 已注册 |

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
- HR Agent 未在本地启动；本批定向测试不需要调用云端 AgentKit。
- 未运行 Batch 06/07 的真实端到端验收，它们按后续批次边界执行。

## 工作区

- `git diff --check`：PASS。
- 提交只包含 Batch 05 的 Continuation 消费、Harness 恢复、waiting_user/用户回答、执行租约、正式启动接线、定向测试和证据。
- 提交后工作区要求干净。
