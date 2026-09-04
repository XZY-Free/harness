# Batch 02 Evidence

## 元信息

| 项 | 值 |
|---|---|
| Batch | `02` |
| 起点 SHA | `abe0eaabc4a536445ad4907248164697ef75de32` |
| 终点 SHA | `SELF_COMMIT` |
| 提交标题 | `fix(runtime): preserve trusted execution subject` |
| 开始时间 | `2026-09-04T04:48:00Z` |
| 结束时间 | `2026-09-04T05:16:59Z` |
| 实施者 | `AI direct implementation` |

## 计划内修改

- `ExecutionBinding` 冻结 subject type、stable subject ID、来源类别和冻结时间；tenant 继续复用绑定原字段。
- Dispatcher 强制要求可信 Subject，在创建 Invocation 前拒绝缺失、空值和跨 tenant 主体。
- External Runtime Start 不传业务 Subject；Capability Gateway 验证 Workload Token 后只从父 Invocation 的 Binding 恢复 Effective Subject。
- Hosted executor、Runtime retry、Command recovery、User Action resume 和 AgentCall resume 均重新读取 Binding。
- Agent、Tool、Knowledge 使用同一个平台 executor 上下文；ToolCall 应用输入显式携带该 Subject。
- 新增 `capability.action.execute` 审计，记录 Caller Workload、Effective Subject、Invocation、能力标识和 allow/deny 结果，不记录 action payload 或 Secret。

## Migration

- Migration：`drizzle/0002_careless_spacker_dave.sql`。
- 顺序：先增加可空列，再从 `Invocation.threadId → Thread.ownerUserId` 权威关系回填用户主体，最后收紧为 `NOT NULL`。
- 不推测服务任务身份；若现有行无法从权威事实恢复，`MODIFY NOT NULL` 会阻断迁移。
- Batch 00 已确认当前没有可访问的本地 SnowHarness 数据集；未连接生产数据库。
- Fresh schema 定向测试确认缺少 Subject 的新 Binding 无法写入。

## 生产接线

```text
Authenticated Principal
→ dispatchInvocationForTurn
→ freezeTrustedExecutionSubject
→ ExecutionBinding
→ Hosted / Retry / Capability Gateway / User Action Resume
→ recoverTrustedExecutionSubject
→ Agent / Tool / Knowledge executor
→ AuditEvent(caller workload + effective subject)
```

## 定向测试

| 命令 | 测试文件 | 测试数 | 退出码 | 结果 |
|---|---|---:|---:|---|
| `vitest <trusted subject unit + DB>`（RED） | 2 exact files | 8 | 1 | 预期失败：冻结/恢复函数与 DB 字段尚不存在 |
| `vitest <Batch 02 five exact files>`（GREEN） | Subject unit/DB、Runtime dispatch、External Gateway、production wiring | 22 | 0 | PASS |
| `pnpm typecheck` | 全仓类型边界 | 0 tests | 0 | PASS |
| `git diff --check` | 本批 diff | 0 tests | 0 | PASS |

## 本批验收 ID

| ID | 结果 | 证据 |
|---|---|---|
| SUB-01—SUB-05 | PASS | Binding、Dispatcher、Gateway 与静态生产接线均有定向测试 |
| SUB-06 | PASS（Batch 02 范围） | Runtime retry、Hosted、Command/User Action/Agent resume 读取 Binding；Continuation 留待 Batch 05 |
| SUB-07 | PASS | Token 跨 tenant、跨 Invocation 均失败关闭 |
| SUB-08 | PASS | 允许与拒绝审计均同时包含 Caller Workload 和 Effective Subject |
| SUB-09 | PASS（Batch 02 范围） | 两条运行路径共用 Binding Subject；真实 HR Agent E2E 留待 Batch 07 |
| CAP-09 | PASS | Tool 使用可信 Subject、冻结 Operation/Schema、确认政策和逻辑幂等键 |
| ARC-05 | PASS（Batch 02 回归点） | Runtime Binding 与 AgentCall Authority 保持分离 |

## 明确未运行

```text
full_test_suite = false
fresh_db_full = false
all_e2e = false
all_builds = false
github_full_ci = false
```

## 偏差

- 迁移对无法权威回填的历史行选择阻断，不创建默认用户或固定 gateway 身份。
- 未访问生产数据库；未创建 Credential、Connection 或 Session。
- HR Agent 未在本地启动，也未进行不属于本批的 AgentKit 联调。

## 工作区

- `git diff --check`：PASS。
- 提交只包含本批生产代码、Schema/Migration、精确测试、必要测试夹具、审计 UI 标签和证据。
- 提交后工作区要求干净。
