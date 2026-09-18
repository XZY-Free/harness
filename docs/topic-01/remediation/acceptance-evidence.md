# 批次06：验收与 Schema 证据修复记录

## 结果

P1-05 已修复。Topic01 验收只依赖当前仓库中的 canonical 文件，不再读取旧 V12 工程包、编号证据副本或固定历史 commit title。旧 `CLOSED` 报告与旧 `docs/implementation/topic-01-final-closure` 证据已删除。

本批实现提交：`27cbe17`（重建 Topic01 验收与 Schema 证据）。

## Canonical evidence

- `docs/topic-01/evidence/acceptance-matrix.json`
- `docs/topic-01/evidence/verification-plan.json`
- `docs/topic-01/evidence/acceptance-result.schema.json`
- `docs/topic-01/evidence/schema-inventory.json`
- `docs/topic-01/evidence/schema-inventory.schema.json`
- `docs/topic-01/evidence/schema-manifest.json`
- `docs/topic-01/evidence/test-collection.json`
- `docs/topic-01/evidence/skipped-test-registry.json`

长期机器文件使用稳定名称，不再以批次编号作为 API。

## 运行产物与受控基线的分离

上表全部文件**受版本管理**（`docs/` 虽被 `.gitignore` 排除，这些文件已跟踪，改动需显式 `git add`；
新增同类基线文件需 `git add -f`）。验收脚本同样在 `scripts/` 下受版本管理。

流程自身重写的运行产物**不进版本管理**，统一落在 `docs/topic-01/evidence/artifacts/`：

- `artifacts/acceptance-result.json` —— 每次运行由 `scripts/acceptance.mjs` 重建，
  记录 `localAcceptanceSha`、`runId`（`<sha12>-<epochMs>-<pid>`）、真实逐阶段退出码、跳过明细。
- `artifacts/vitest-skipped-tests.json` —— 由 `scripts/vitest-stage.mjs` 按
  `skipped-test-registry.json` 允许清单生成的实际跳过记录。

分离原因：产物在运行中被流程自己重写，若纳入跟踪则 `worktree-cleanliness` 必然判脏，
门禁只能靠放宽来通过。路径常量唯一来源是 `scripts/acceptance-contract.mjs`
（`RESULT_PATH` / `SKIPPED_TESTS_PATH`），`.gitignore` 中另有指向该目录的显式条目。

## Schema evidence

生成器每次从当前 Canonical Schema、runtime-loaded schema、clean migration 和当前生产源码重新构建 122 张表的证据，不读取或合并旧 inventory。

生产源码过滤明确排除 `.test.*`、`.spec.*`、`test`、`tests`、`__tests__`、`test-support`、fixture、mock、fake、E2E 与 generated evidence；`scripts/workers/**` 保留为生产入口。每张表记录 owner、writer、reader、lifecycle、authority kind、租户边界、约束和证据路径。当前 122 张表均有直接生产 writer 与 reader，无需受控 projection 例外。

Fresh DB introspection 未在本批运行，已作为批次07正式阶段，要求 Canonical、clean migration、runtime-loaded 与空库物理表完全一致。

## Acceptance 与 CI

- Matrix 精确覆盖 10 个阻断项，每项绑定 production entry、Authority、machine gate、test evidence、evidence artifact 和行为 pass condition。
- Verification plan 共 14 个阶段，完整 profile 包含静态架构、Schema、唯一 Vitest 收集、生产接线、Fresh DB、Web/Desktop build、三类 E2E、安全检查、矩阵、工作区清洁性和最终证据完整性。
- Acceptance result 记录 baseline SHA、local acceptance SHA、remote HEAD SHA、GitHub CI 状态、四份 canonical digest 和 skipped test 明细。
- `CLOSED` 必须同时满足本地完整验收通过、`remoteHeadSha == localAcceptanceSha` 和 exact HEAD GitHub CI passed。
- CI checkout `github.sha`，并运行与本地相同的 `pnpm topic01:acceptance`。

## 定向验证

- Schema generator：Canonical、Runtime 与 Migration 均为 122；Fresh DB 留待批次07。
- Test collection audit：425 个文件唯一归组；unit=274、db=109、integration=10、contract=27、Web E2E=3、Desktop E2E=1、Cross-client E2E=1。
- Batch06 定向 Vitest：9 个文件、36 个测试通过。
- Production wiring contract：10/10 通过。
- `pnpm typecheck`：通过。
- `pnpm architecture:gate`：通过。
- `git diff --check`：通过。
- `topic-01-acceptance --plan` quick profile 与单 stage 选择：通过。

本批未运行完整 acceptance、全仓 Vitest、Fresh DB、生产 build 或 Playwright；这些只在批次07执行。

## 收口

本批 TODO：0。

当前状态：批次06通过，专题01尚未关闭，等待批次07完整本地验收与 exact HEAD GitHub CI。
