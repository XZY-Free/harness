# Batch 01 Evidence

## 元信息

| 项 | 值 |
|---|---|
| Batch | `01` |
| 起点 SHA | `70e17ac051bc4171de9ce540b0126728974a7bb6` |
| 终点 SHA | `SELF_COMMIT` |
| 提交标题 | `feat(harness): bind production capability catalog and tool execution` |
| 开始时间 | `2026-09-04T04:18:00Z` |
| 结束时间 | `2026-09-04T04:36:46Z` |
| 实施者 | `AI direct implementation` |

## 计划内修改

- 定义 Invocation 级目录合同、规范摘要、模型安全视图与行动校验。
- Dispatcher 在创建 ExecutionBinding 前解析 preferred Agent exact Route/Contract、已发布 Tool Schema 与活跃 KnowledgeBase。
- ExecutionBinding 持久保存目录 JSON、SHA-256 摘要、版本、来源引用和创建时间。
- Runtime Start 携带已验证目录；Hosted Loop 与 External Capability Gateway 使用相同目录。
- 共享生产 executor 工厂注册 `tool.call`，通过既有 ToolCall create/state 服务落库。
- 旧测试夹具统一使用有效的空目录 helper，只用于与本批无关的既有测试建 Binding。

## Authority 变化

| 事实 | 修改前 | 修改后 |
|---|---|---|
| Invocation 能力集合 | Turn directive 与调用时实时查询 | ExecutionBinding 的不可变目录快照 |
| 目录完整性 | 无 | `capabilityCatalogDigest` 重新计算，不一致即失败 |
| Agent 可见信息 | preferred Agent ID | exact revision/route/contract 的安全说明 |
| Tool 行动授权 | action schema 只验证形状 | 冻结 Tool/Operation/JSON Schema/确认要求 |
| `tool.call` 执行 | 共享工厂未注册 | 共享工厂 → ToolCall 正式应用服务 |

## Migration

- Migration：`drizzle/0001_quick_korvac.sql`。
- 新增 5 个 NOT NULL 字段：snapshot、digest、version、source refs、created at。
- 数据画像：Batch 00 已确认当前无可访问的本地 SnowHarness 数据集，未连接生产数据库。
- 回填：不伪造历史目录；存在旧 ExecutionBinding 的环境必须先由升级预检阻断并人工确认，不允许查询“当前最新目录”冒充历史快照。
- 验证：Fresh migration 的 `information_schema` 定向测试确认 5 列存在且均不可空。

## 生产接线

```text
Turn API → Dispatcher → buildProductionCapabilityCatalog
→ ExecutionBinding(snapshot + digest + sources)
→ Runtime Start
→ Hosted HarnessLoop / External Runtime
→ validateHarnessActionAgainstCatalog
→ createPlatformHarnessActionExecutors
→ executeHarnessToolCall
→ ToolCall repository/state
```

Capability Gateway 从 ExecutionBinding 恢复并验证目录，不接受 Runtime 请求正文自报能力。Tool executor 不读取 Provider endpoint，不直接完成父 Invocation；running/paused 返回 pending，终态转换为 Observation。

## 定向测试

| 命令 | 测试文件 | 测试数 | 退出码 | 结果 |
|---|---|---:|---:|---|
| `vitest --project db <4 exact files>`（RED） | capability catalog unit/db、action validation、tool executor | 1 collected + 3 import failures | 1 | 预期失败：模块与列尚不存在 |
| `vitest --project db <4 exact files>`（GREEN） | 同上 | 14 | 0 | PASS |
| `vitest --project unit scripts/topic-01-production-wiring.contract.test.ts` | production wiring contract | 3 | 0 | PASS |
| `pnpm typecheck`（修复后复核） | 全仓类型边界 | 0 tests | 0 | PASS |
| `git diff --check` | 本批 diff | 0 tests | 0 | PASS |

## 本批验收 ID

| ID | 结果 | 证据 |
|---|---|---|
| CAP-01—CAP-08 | PASS | 目录合同、持久列、生产构建/恢复、校验与 ToolCall 接线均有定向测试 |
| CAP-09 | PASS（Batch 01 范围） | Operation、Schema、确认政策、逻辑幂等键已冻结；Subject 延续由 Batch 02 验收 |
| CAP-10 | PASS（Batch 01 范围） | Hosted/External 共用目录、校验器与 executor 工厂；最终真实流程由 Batch 07 验收 |
| ARC-01、ARC-02 | PASS（Batch 01 回归点） | 顶层仍为 Harness；Agent 仍只从 Harness `agent.call` 进入 |

## 明确未运行

```text
full_test_suite = false
fresh_db_full = false
all_e2e = false
all_builds = false
github_full_ci = false
```

## 偏差

- 计划外偏差：无。
- 未解决阻断：无。
- 本批执行了一次非测试型全仓 TypeScript 检查；首次暴露旧 Binding 夹具缺新字段，统一迁移后复核通过。
- HR Agent 未在本地启动，也未进行不属于本批的真实 HR Agent 业务联调。

## 工作区

- `git diff --check`：PASS。
- 提交只包含本批生产代码、Schema/Migration、精确测试、必要测试夹具和证据。
- 提交后工作区要求干净。
