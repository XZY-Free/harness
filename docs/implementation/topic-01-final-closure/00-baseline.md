# Topic 01 封版基线

## 仓库状态

| 项目 | 观测值 |
|---|---|
| 分支 | `main` |
| 执行起点 HEAD | `3197cfeb23070f818aacdfa7db9662986c23ecce` |
| 冻结提交 | `704b022735d64c176d9096406ae9a61d2e01eafd` |
| 提交关系 | 冻结提交是执行起点 HEAD 的祖先 |
| 起点工作区 | 干净，`git status --short` 无输出 |
| 冻结提交至起点 HEAD | 101 个文件，6,524 行新增、2,430 行删除 |
| Node.js | `v24.19.0` |
| pnpm | `10.32.1` |
| MySQL Client | `9.6.0` arm64 |
| `pnpm-lock.yaml` SHA-256 | `cfa9d6a8038f4059abace479638a001217f7c536bdd6119686e78397fc758e95` |

记录时间：`2026-09-04T03:58:21Z`。

## 冻结提交之后的差异判断

冻结提交之后共有 101 个文件变化。逐文件路径分类后，差异落在以下范围：

- `app/studio/**`、`components/studio/**`、`lib/studio/**`：Studio 页面、导航、设置与其测试。
- `components/thread/**`、`components/desktop/**`、`components/workspace-panel/**`：员工端与桌面端展示、响应式交互及其测试。
- `app/layout*`、`app/globals.css`、`public/theme-init.js`：全局布局与主题。
- `components/ui/popover.tsx`：浮层 resize 修复。
- `e2e/web-execution-chain.spec.ts`：既有端到端断言调整；这是唯一与最终验收测试入口相邻的变化，Batch 07 必须在真实 Web 流程中重新验证。

以下 Topic 01 核心范围在冻结提交之后没有变化：`lib/runtime/**`、`lib/agents/calls/**`、`lib/executions/**`、`lib/control-plane/events/**`、`lib/persistence/schema/**`、`drizzle/**`、Runtime/Gateway API 路由。现有 101 个文件均已归入上述分类，没有发现来源不明的核心实现改动。

## 脚本与 Schema 基线

`package.json` 当前提供以下入口：

| 类别 | 脚本 |
|---|---|
| 测试 | `test` → `vitest run` |
| 类型 | `typecheck` |
| 数据库 | `db:generate`、`db:migrate`、`db:seed`、`db:verify:fresh` |
| 构建 | Web/Worker/Desktop 各构建脚本 |
| 静态检查 | `lint`、安全合同、协议合同、Architecture check/gate |
| Worker | Hosted Provisioning、Control Plane Outbox、Runtime Dispatch Retry |
| 总验证 | `verify` → `scripts/verify.mjs` |

当前尚无 `topic01:acceptance`。Batch 06 负责建立唯一完整本地验收入口，并让 `verify` 与工作流复用相同底层阶段。

Schema 唯一根为 `lib/persistence/schema/index.ts`；`drizzle.config.ts` 与 `lib/db/client.ts` 均加载该根。当前迁移为 `drizzle/0000_initial_schema.sql`，既有最终清单记录 123 张表。Batch 06 必须从 Canonical Schema、Runtime 实际加载、Migration 和 Fresh DB 四个事实源重新生成并核对清单，不能用 123 作为保留目标。

## 只读数据风险盘点

开发配置指向 `127.0.0.1:3308/snow_harness`，执行时该端口没有 MySQL 服务；仓库默认的 `3307` 也没有监听，Docker 中没有 SnowHarness 容器或数据卷。`3306` 上的本机 MySQL 不接受本项目凭证，未继续尝试。全程未连接生产数据库，也未启动或写入任何数据库。

因此本批能确认的是“当前没有可盘点的本地项目数据集”，而不是把未知行数写成零：ExecutionBinding、AgentCall、Binding、Session、Attempt、Ingress 的实际行数均记为 `not_observed`。已知未解决的活跃迁移歧义为 0，但这不是对数据库行数的推断。Batch 03 的迁移验证器必须在任何现存数据库升级前重新盘点，并对以下情况 fail closed（失败即停止）：

- 非终态 ExecutionBinding 无法唯一追溯主体；
- AgentCall 的 revision、context、task 权威字段冲突或缺失；
- `logicalCallKey` 无法无歧义构造；
- 多 Attempt 的历史事件无法映射到唯一 Attempt。

## 测试执行边界

Batch 00 未运行测试套件、Fresh DB、Build 或 GitHub CI，只执行文档、JSON、引用和差异检查。Batch 00—06 均遵守定向测试限制；完整验收只允许在 Batch 07 通过 `pnpm topic01:acceptance` 运行。

涉及 HR Agent 的测试不得启动 `/Users/sunshine/IdeaProjects/人力agent/hr-agent`。只有明确需要真实 HR Agent 联调时才调用已部署的云端 AgentKit 服务；普通回归使用 SnowHarness 自有测试 Agent，避免把外部可用性变成本工程包的隐含前置条件。
