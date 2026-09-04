# Batch 03 Evidence

## 元信息

| 项 | 值 |
|---|---|
| Batch | `03` |
| 起点 SHA | `9d59c604abb93a551beb0f8a7ecff5ca720e4a94` |
| 终点 SHA | `SELF_COMMIT` |
| 提交标题 | `refactor(agent-call): enforce canonical call authorities` |
| 开始时间 | `2026-09-04T05:28:00Z` |
| 结束时间 | `2026-09-04T05:58:57Z` |
| 实施者 | `AI direct implementation` |

## Authority 收口

| 事实 | 唯一 Authority | 生产读取 |
|---|---|---|
| exact Agent revision、合同、发布、路由、endpoint、credential ref | `AgentCallBinding` | start/retry、Gateway 查询、Trace 均关联 Binding |
| A2A contextId | `AgentSessionBinding.externalContextRef` | waiting_user 协调与查询投影关联 Session |
| A2A taskId、attemptNo、请求摘要、通道、重试和错误 | `AgentCallAttempt` | Event Ingress 按 task/current Attempt 定位；不再读 AgentCall 主表 |
| Parent、Harness action、stable Agent、状态、结果、错误和版本 | `AgentCall` | 主表不再保存 task/revision/context |

## 幂等与当前 Attempt

- 应用服务只接收 `actionId` 与 stable `agentId`，统一生成 `harness-action:<actionId>:agent:<agentId>`；调用方不能提交自定义 logical key。
- `sourceType` 数据库枚举只允许 `harness_planned`，`sourceRef` 和 `logicalCallKey` 均为 `NOT NULL`。
- 同一 Parent Invocation/action/Agent 的并发创建由父 Invocation 行锁和数据库唯一键串行，只生成一个 Call/Binding/Attempt/CapabilityUse。
- 新 Attempt 只能在上一 Attempt 终态后创建，编号由仓储按最大编号加一分配。
- 当前 Attempt 优先解析唯一活动 Attempt；没有活动 Attempt 时取编号最大的终态 Attempt。事件、waiting_user、cancel、resume、Gateway 查询和 Trace 均不默认 Attempt 1。
- `transportChannel` 只写 Attempt，允许 `hosted`、`gateway`；AgentCall 的业务来源始终为 `harness_planned`。

## Migration

- Migration：`drizzle/0003_sweet_peter_parker.sql`。
- DDL 前先检查来源行动缺失、非终态孤儿、重复逻辑语义、task 到 Attempt 歧义、task/context 重复映射、Attempt 编号断裂和无法解析通道。
- 任一冲突通过 CHECK guard 阻断；不选择最新 revision/route，不默认 Attempt 1，不静默覆盖。
- 检查通过后规范化全部 logical key，把旧 task 映射到唯一 Attempt，并从父 Invocation 的 `ExecutionBinding.runtimeEvidenceKind` 回填 hosted/gateway 通道。
- 最后收紧来源、logical key 和通道约束，建立 task/context 唯一键并删除 AgentCall 的旧 task 列。
- Batch 00 已确认当前没有可访问的本地 SnowHarness 数据集；未连接生产数据库。

## 定向测试

| 命令 | 测试文件 | 测试数 | 退出码 | 结果 |
|---|---|---:|---:|---|
| `vitest <Batch 03 five exact files>`（RED） | 5 exact files | 9 | 1 | 预期失败：主表 task/nullable key、Attempt API、context 唯一约束和迁移 guard 尚未实现 |
| `vitest <Batch 03 six exact files>`（GREEN） | 5 数据测试 + production wiring | 16 | 0 | PASS |
| `pnpm typecheck` | 全仓类型边界 | 0 tests | 0 | PASS |
| `biome check <changed TypeScript>` | 本批 TypeScript | 0 tests | 0 | PASS |
| `git diff --check` | 本批 diff | 0 tests | 0 | PASS |

## 本批验收 ID

| ID | 结果 | 证据 |
|---|---|---|
| DATA-01—DATA-03 | PASS | 数据库元数据确认 AgentCall 无 revision/context/task 列；生产读写改从 Binding/Session/Attempt 获取 |
| DATA-04 | PASS | 发布新 Agent revision 后创建并真实启动 Attempt 2，仍使用原 Binding endpoint/revision/route |
| DATA-05 | PASS | tenant + context 唯一约束；相同 owner 幂等、不同 owner 冲突 |
| DATA-06 | PASS | Attempt 严格递增、task 唯一绑定、task 精确查询和当前 Attempt 解析 |
| DATA-07 | PASS | 应用拒绝空 action/Agent；数据库 logical key 非空且规范化 |
| DATA-08 | PASS | 真实 MySQL 并发创建只产生一个 Call |
| DATA-09 | PASS | AgentCall 只允许 `harness_planned`；hosted/gateway 仅存在 Attempt 元数据 |
| DATA-10 | PASS | Attempt 1 失败、Attempt 2 活动时所有权威读取选择 Attempt 2 |
| DATA-11 | PASS | Migration guard 在任何 DDL 前执行并包含精确冲突类别；冲突画像函数稳定报告 |

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
- Batch 04 的统一状态转换和一事件一事务尚未提前实现。

## 工作区

- `git diff --check`：PASS。
- 提交只包含 Batch 03 的数据 Authority、Migration、生产读取切换、精确测试和证据。
- 提交后工作区要求干净。
