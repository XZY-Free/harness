# Batch 06 证据

## 变更结论

- Canonical、Runtime-loaded、Migration、Fresh DB 计划均为 120 张应用表。
- 从旧 123 基线删除 `MemoryIndex`、`WorkspaceMergeConflict`、`WorkspaceOverlay`：三者没有生产 writer、reader、Worker 或运维消费者。
- `__drizzle_migrations` 是框架内部元数据，单独排除，不混入应用清单。
- 414 个测试文件全部唯一归属：Vitest 四组与 Playwright 三组之间无重叠。
- `73-verification-plan.json` 是 13 阶段唯一验证 Authority；`topic01:acceptance`、`verify` 与 GitHub Workflow 共用该计划。

## 本批检查边界

本批只执行静态清单、重复检测、新增 Architecture Gate、计划打印与差异检查：

| 检查 | 结果 |
|---|---|
| `pnpm topic01:schema:verify` | exit 0；JSON Schema、唯一覆盖、writers/readers、Root/Runtime/Migration/Fresh 四集合均通过 |
| `pnpm topic01:tests:audit` | exit 0；414 文件唯一归属，无单文件重复执行 |
| Architecture 新规则定向测试 | 94 tests passed |
| `pnpm architecture:gate` | exit 0；含本批十项冻结边界 |
| `pnpm topic01:acceptance --plan` | exit 0；只打印 13 阶段，未执行阶段 |
| `git diff --check` | exit 0 |

未运行完整 Vitest、Fresh DB、Web/Desktop build、Web/Desktop/Cross-client E2E 或 GitHub CI；这些结果不得提前写为通过。

## 外部 Agent 边界

未启动 `/Users/sunshine/IdeaProjects/人力agent/hr-agent`。本批静态检查不需要外部 AgentKit 调用。
