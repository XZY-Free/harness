# SnowHarness 专题 01 最终完成报告

> 日期：2026-08-31
>
> 范围：Harness Loop、AgentUseDirective、AgentCall 执行/恢复、Schema 单一 Authority、Web/Desktop 与最终验收
>
> 生产环境、生产数据库、外部业务 Agent 源码及线上部署均不在本次操作范围内。

## 1. 交付边界与 Git 状态

| 项 | 结果 |
|---|---|
| branch | `main` |
| start HEAD | `ce93a9380c7539136203ef3bc96eda9cea9ceb6f` |
| start commit | `ce93a93 专题01 工程包07：消除Desktop生成器测试的本地残留依赖` |
| start worktree | clean |
| end HEAD | 本报告所在 Batch 8 commit；Git 对象不能在自身内容中嵌入自己的最终 hash，精确值见 `git log -1 --oneline` |
| end worktree | Batch 8 commit 后 clean |
| push | no |

每批次均只提交本批相关文件：

| Batch | commit | 内容 |
|---|---|---|
| 0 | 未提交 | 只读盘点，报告随 Batch 6/7 纳入版本库 |
| 1 | `6d971e6` | 收口 Turn 级 AgentUseDirective 协议 |
| 2 | `2d102f5` | 实现可恢复的 Harness 行动循环 |
| 3 | `df97e75` | 统一 Harness Agent 行动执行器 |
| 4 | `4daeae2` | 完善 Harness 恢复与控制语义 |
| 5 | `3ade6e6` | 统一 Agent 使用投影与执行观测 |
| 6 | `4ce9ad4` | 统一 Schema 权威并删除旧数据层 |
| 7 | `9e63321` | 生成干净初始迁移并验证空库启动 |
| 8 | 本报告所在 commit | 修复总验收发现的问题并完成全量验收 |

## 2. 最终执行形态

顶层调用保持 Runtime-only：

```text
POST Turn(agent_use?)
  -> acceptUserMessageTurn
  -> dispatchEmployeeTurn(target=runtime)
  -> dispatchInvocationForTurn
  -> Runtime Start(capability_directives)
  -> HarnessDecisionPort: 每步一个 action
  -> commit action events
  -> action executor
  -> observation
  -> HarnessDecisionPort
  -> respond commit
  -> HarnessFinalResponsePort
  -> response.delta / response.completed
  -> assistant_message projection
```

Agent 是 Harness 能力，不是顶层执行目标：

```text
agent.call
  -> AgentActionExecutor
  -> resolve exact Agent Route
  -> AgentCall + AgentCallBinding + AgentCallAttempt + CapabilityUse
  -> startAgentCall
  -> A2A stream
  -> AgentCallEventIngress
  -> Agent observation
  -> Harness Loop 决定下一步或最终回答
```

外部 Agent 的结果不会直接生成顶层 `assistant_message`。一旦 `agent.call` 已提交，executor、Route、Binding、Credential 或 A2A 失败均显式失败；禁止退回 model-only 伪造答案。

## 3. AgentUseDirective 与会话语义

最终字段和 wire：

| 位置 | 字段 |
|---|---|
| `Turn` | `preferredAgentId`, `agentUseMode` |
| Employee API | `agent_use: { mode: "preferred", agent_id: "<Agent.id>" }` |
| Runtime Start | `capability_directives: [{ capability_type: "agent", capability_id, mode: "preferred" }]` |

- `agent_use` 省略或 `null`：当前新 Turn 无 Agent 偏好，不继承历史。
- 同一 Thread 可依次选择 HR、改选 Contract、清除、再选 HR；每个 Turn 的事实独立且历史不可改写。
- 用户选择只是 preferred candidate，Harness 可根据问题和证据决定 0 次或 1 次调用。
- Web/Desktop 最近选择只用于 Composer 待发送回显；每次发送仍显式提交 payload。
- Regenerate 仍是同一个 Turn，复用该 Turn 原 directive；更换 Agent 后重新提问必须创建新 Turn。
- waiting_user resolve 恢复原 `AgentCall`、Binding、Session、task 和 context，不读取后来改变的 Composer 选择。
- `Thread` 没有 primary/default/current/active/preferred Agent 字段；顶层 `ExecutionBinding` 也没有 Agent evidence。

## 4. Harness actions 与 Agent 错误语义

行动集合：

- `knowledge.search`
- `tool.call`
- `agent.call`
- `request_user_input`
- `respond`

行动循环统一遵循 `observe -> decide one action -> commit -> execute -> observe`。恢复使用已有 Invocation/Event、ToolCall、AgentCall、CapabilityUse 和 ContextCheckpoint，不新增第二套 Loop 状态表，也不持久化隐藏思维链。

`AgentActionExecutor` 接收 Harness 形成的 `actionId`、`stepNo`、`agentId`、`task`、`purposeCode`、`contextRefs` 和 ExecutionSubject。当前阶段 action 的 Agent 必须等于本 Turn 的 preferred Agent，否则返回 `AGENT_ACTION_NOT_ALLOWED`；executor 缺失返回 `AGENT_CALL_EXECUTOR_UNAVAILABLE`。`logicalCallKey` 由 parent Invocation、action 和 Agent 稳定构造，同一正式 action 不重复调用。

## 5. 恢复、input-required 与取消

- `input-required` 原子推进 AgentCall、Parent Invocation、Turn 到 waiting，并创建 `UserActionRequest`。
- resolve 后继续原 AgentCall/Binding/Session/context/task/action；即使 Composer 已改选另一个 Agent，也不会切换执行对象。
- Parent cancel 会传递给 active AgentCall；远端 `cancel=false` 被保留为真实结果，不伪造已取消。
- action proposed、started、pending、completed 但 observation 未落、waiting_user 等恢复点均有测试；恢复不会重复 AgentCall/ToolCall。
- pause 类 ToolCall 现在在同一事务内把匹配的 active Turn 推进到 `waiting_user`，并用 active Invocation 条件做并发保护。
- 同一 Thread 中不同 Invocation 可合法复用模型生成的 actionId；ThreadEvent 幂等键已加入 Invocation id，避免跨 Turn 冲突。

## 6. Web、Desktop 与可观测结果

- Web 与 Desktop 使用相同 Employee API、Turn payload 和事件投影。
- Turn 投影分别暴露 `agent_use` 与实际 `agent_calls`，选择但未调用不会伪装为 CapabilityUse。
- 真实跨客户端 E2E 在同一 Thread 中由 Web 和 Desktop 分别发送新 Turn，两个客户端看到同一事件事实；每个 Turn 的 Agent 选择以各自 payload 为准。
- E2E 修复了无障碍名称的模糊匹配：普通消息框使用 exact label，不会误操作“队列消息输入框”。

## 7. 删除的旧实现

物理删除且无 compatibility/re-export：

- `agent_selection.required`、`requestedAgentId`、`agentSelectionMode`、`capability_requirements`。
- `invokeRequiredAgent`、`harness-required-agent`、`RequiredAgentUnavailableError`、required-agent logical key。
- `lib/db/schema.ts`、`lib/db/queries.ts` 及其旧 writer/consumer。
- 依赖旧表的 Studio MCP/custom tool API 与面板，以及旧 retry/summary/secret-mount/deploy/git checkpoint 模块。

## 8. Schema Authority 与表清理

### 8.1 before / after

| 集合 | before | after |
|---|---:|---:|
| Canonical Root | 123 | 123 |
| Runtime Drizzle | 106（缺 30 张 canonical 表，另混入 13 张 legacy 表） | 123 |
| Migration | 123 | 123 |
| Fresh MySQL | 123 | 123 |
| 方案形成时开发库 | 118（缺 AgentCall 域 5 表） | 未修改；本次禁止用开发库冒充 Fresh DB |

最终 `drizzle.config.ts`、Runtime Drizzle、测试和 Migration 只消费 `lib/persistence/schema/index.ts`。完整 123 表 keep/move 后清单见 [`docs/implementation/topic-01-loop-schema/07-final-schema-manifest.json`](docs/implementation/topic-01-loop-schema/07-final-schema-manifest.json)，逐表 writer/reader/Authority/投影/生命周期决策见 [`docs/implementation/topic-01-loop-schema/04-schema-table-inventory.md`](docs/implementation/topic-01-loop-schema/04-schema-table-inventory.md)。

### 8.2 merge/delete 清单

| 旧表 | 决策 | 最终 Authority |
|---|---|---|
| `User` | merge/delete | `UserIdentity` + `PrincipalBinding` |
| `AdminAuditLog` | merge/delete | `AuditEvent` |
| `ToolRun` | delete | `ToolCall` + `EffectRecord` + `Artifact` |
| `ContextSnapshot`, `ContextSummary` | delete | `ContextCheckpoint` + Trace/Observation |
| `ThreadPlan`, `ThreadPlanItem` | delete | Harness action history + `Goal` |
| `GitCheckpoint` | delete | `FilesystemCheckpoint` |
| `McpServerConfig`, `CustomTool` | delete | `Connection` + `ToolProvider` + `Tool` + `ToolSchemaRevision` |
| `SecretMount` | delete | `CredentialRef` + 外部 Credential Provider |
| `Deployment` | delete | `HostedProvisioningRequest` + `PublicationRecord` + `RouteActivation` + `Artifact` |
| `AuditFailureLog` | delete | `ControlPlaneOutboxEvent` + `ControlPlaneEventDelivery` / `EventDeliveryFailure` |

没有另建表来替代旧表；keep/move 是把正式表统一移入单一 Canonical Root。完整映射见 [`docs/implementation/topic-01-loop-schema/05-old-new-authority-map.md`](docs/implementation/topic-01-loop-schema/05-old-new-authority-map.md)。

### 8.3 AgentCall 字段 Authority

| 事实 | 唯一 Authority |
|---|---|
| exact Agent revision | `AgentCallBinding.agentRevisionId` |
| A2A context id | `AgentSessionBinding.externalContextRef` |
| A2A task id | `AgentCall.externalTaskRef` |

`AgentCall.agentSessionBindingId` 只是 context Authority 的外键；`AgentCallAttempt` 不复制 task id。

### 8.4 Clean migration / Fresh DB

- 仅保留 `drizzle/0000_initial_schema.sql` 一条干净初始迁移；无 rename/drop/backfill 兼容链。
- 初始迁移保留 `RouteRevision`、`RouteActivation` append-only update trigger。
- `pnpm db:verify-fresh` 在空 MySQL 8 上完成 migrate、seed、123 表 manifest 对比、Next.js 启动和真实 HTTP 请求。
- seed 结果：Tenant 1、UserIdentity 1、RoleActionBinding 21、Agent 0；`GET /` 返回 HTTP 307。
- 详细证据见 [`docs/implementation/topic-01-loop-schema/08-clean-migration-and-fresh-db.md`](docs/implementation/topic-01-loop-schema/08-clean-migration-and-fresh-db.md)。

## 9. A–Q 验收矩阵

| 场景 | 结果 | 主要证据 |
|---|---|---|
| A Agent=0 基础 Harness | PASS | Fresh DB + Web/Desktop E2E；空 Agent 合法且主链完成 |
| B 选择 Agent 但普通问候 | PASS | Harness/HostedAdapter 测试：0 AgentCall，直接 respond |
| C 制度问题 Knowledge-only | PASS | `knowledge.search -> respond` 行动循环与真实 gateway knowledge 测试 |
| D 余额问题 AgentCall 后回答 | PASS | AgentActionExecutor + 真实 A2A stream + Harness final response |
| E Knowledge 后 AgentCall | PASS | `knowledge.search -> agent.call -> respond`，两类 evidence ref 均进入最终回答 |
| F committed call 但 executor 缺失 | PASS | 显式失败，无 final response、无 model-only fallback |
| G Agent Route disabled 但无需调用 | PASS | selected 不等于 required；可直接 respond |
| H Agent Route disabled 且正式调用 | PASS | Route 解析稳定失败，无伪答案 |
| I input-required/resume | PASS | 同一 Call/Session/context/task 恢复 |
| J cancel | PASS | accepted 与 `cancel=false` 均按真实结果投影 |
| K 关键恢复点重启 | PASS | proposed/started/pending/completed-before-observation/waiting_user 与 lease redispatch |
| L Fresh DB 主链 | PASS | 空 MySQL migrate/seed/boot/HTTP + E2E |
| M HR -> Contract -> null -> HR | PASS | 每 Turn directive 独立，omitted/null 不继承 |
| N Web/Desktop 不同选择 | PASS | 真实 Chromium + Electron，共享 Thread/Route/RuntimeRevision，按新 Turn payload |
| O 运行中改选 | PASS | 历史 Turn/Invocation/AgentCall 不变，只影响下一 Turn |
| P Regenerate | PASS | 同 Turn 保留 preferredAgentId；改选需新 Turn |
| Q waiting 时改选 | PASS | resolve 继续原 Call/Session/task/context，0 个新 Agent Call |

A–Q 使用分层证据，不声称每一项都是 Playwright：至少一组真实主链同时包含 MySQL、HTTP、A2A、Employee API、Web Chromium 和 Electron Desktop；状态机、故障与恢复矩阵由真实 MySQL 集成测试覆盖。

## 10. 验证记录

### 10.1 最终通过结果

| 命令 | exit | 结果 |
|---|---:|---|
| `pnpm lint` | 0 | 1,297 files checked |
| `pnpm typecheck` | 0 | TypeScript 无错误 |
| `pnpm test` | 0 | 361 files passed、1 skipped；5,176 tests passed、1 skipped |
| `pnpm architecture:check` | 0 | 839 modules、1,782 dependencies |
| `pnpm architecture:gate` | 0 | 全部门禁 PASS；Schema manifest 123 |
| `pnpm contracts:verify` | 0 | 63 operations、103 events、95 errors、21 conformance cases |
| `pnpm build:test` | 0 | Next.js production build PASS |
| `pnpm build:desktop` | 0 | Desktop build PASS；仅有 chunk-size warning |
| `pnpm test:e2e` | 0 | 15/15 PASS，29.2s |
| `pnpm db:verify-fresh` | 0 | migrate -> seed -> manifest 123 -> Next boot -> HTTP 307 |
| `pnpm verify` | 0 | contracts、typecheck、5,176 tests、lint、architecture、production build 全部通过 |
| failed-file isolated rerun | 0 | `workload-token-revocation.test.ts` 19/19 PASS |

### 10.2 总验收发现并闭合的问题

1. 首次全量测试：6 files / 11 tests failed。修复 ToolCall pause 的 Turn 原子状态、governance fixture、append-only triggers、Fresh schema 测试隔离和 Studio 异步断言后，第二次全量测试 5,174/5,174 通过。
2. Fresh DB 首次在 trigger 创建处报 MySQL 1419；验证为临时测试 MySQL 开启 binary log 且测试用户无 SUPER。Fresh verifier 使用与项目其他真实 DB/E2E 一致的 `--disable-log-bin` 启动参数后通过。
3. E2E 首次把支持脚本误收集为 spec；配置限定 `**/*.spec.ts`。随后跨客户端用例先发现 label 模糊匹配，再发现同 Thread 跨 Invocation 复用 actionId 造成 ThreadEvent 幂等冲突；分别以 exact label 和包含 Invocation id 的幂等键修复，最终 15/15。
4. 第一次 `pnpm verify` 聚合运行在大量遗留 Testcontainers 并存时，`workload-token-revocation` 的 7 个 `beforeEach` 超过 60 秒；终止已注定失败的聚合命令后，只清理本任务精确确认的临时容器。失败文件隔离复跑 19/19，单测恢复到约 0.3–0.5 秒；随后重新执行完整 `pnpm verify`，最终结果见上表。

## 11. 未执行项与剩余风险

未执行：

- 未连接生产数据库，未部署，未 push。
- 未读取或修改 HR/Contract 等外部业务 Agent 源码。
- 未使用生产凭证或生产 Agent endpoint。
- 未执行 macOS 签名、公证或发布安装包；`build:desktop` 只验证本地可构建产物。

剩余风险：

- 外部业务 Agent/provider 的生产网络、真实凭证与限流行为未联调；本次使用本地真实 HTTP/A2A 协议服务和确定性 OpenAI-compatible 模型完成验收。
- Desktop E2E 未启动独立 bridge server，因此存在 bridge WebSocket 重连日志；会话 API 与跨客户端断言均通过，该 warning 不代表主链失败。

环境收尾：

- 按用户要求已删除此前遗留的 MySQL Testcontainers；最终 `docker ps --filter label=org.testcontainers=true` 为空。
