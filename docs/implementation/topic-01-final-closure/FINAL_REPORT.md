# SnowHarness 专题01最终封版报告

## 1. 报告元信息

| 项 | 值 |
|---|---|
| 仓库 | `XZY-Free/harness` |
| 冻结基线 | `704b022735d64c176d9096406ae9a61d2e01eafd` |
| 实施起点 HEAD | `3197cfeb23070f818aacdfa7db9662986c23ecce` |
| 最终实施 HEAD | `bc934cf656caa6b83b83a60dab8500d1be02b5d1` |
| 分支 | `main` |
| 本地验收开始时间 | `2026-09-04T09:16:09.152Z` |
| 本地验收结束时间 | `2026-09-04T09:36:06.302Z` |
| 报告提交 | 本文件所在的 `docs(topic-01): publish final local acceptance evidence` 提交；以 Git 对象为准 |
| 工作区 | `clean`（证据提交后复核） |
| GitHub 完整 CI | `not_run_not_required` |
| 是否 push | `no` |

## 2. 最终结论

```text
专题01主体架构：PASS
专题01最终收口：PASS
专题01状态：CLOSED
```

## 3. 实施范围

本次完成 Invocation 级生产能力目录、生产 `tool.call` 接线、可信执行主体、AgentCall 数据与状态 Authority、持久 Continuation、父 Harness 自动恢复、`waiting_user` 闭环、Schema 逐表证据、测试唯一收集和完整本地验收。

以下冻结语义没有改变：Harness 是唯一顶层主体；Agent 只作为内部能力；Agent 选择是 Turn 级 `preferred`；Thread 不绑定 Agent；Runtime Route 与 Agent Route 分离；Web/Desktop 保持逐 Turn 历史语义。

以下内容不属于本专题：全 Catalog Agent 自动发现、多 Agent、真实外部业务 Agent 联调、GitHub 完整 CI、分支保护及其他专题成熟度。

## 4. Batch 提交

| Batch | 提交 | 标题 | 定向测试 | 证据 | 结果 |
|---|---|---|---|---|---|
| 00 | `70e17ac` | `docs(topic-01): freeze final closure contract` | 无测试套件 | `00-baseline.md` | PASS |
| 01 | `abe0eaa` | `feat(harness): bind production capability catalog and tool execution` | 17 tests | `10-batch-01-evidence.md` | PASS |
| 02 | `9d59c60` | `fix(runtime): preserve trusted execution subject` | 22 tests | `20-batch-02-evidence.md` | PASS |
| 03 | `a0f64b2` | `refactor(agent-call): enforce canonical call authorities` | 16 tests | `30-batch-03-evidence.md` | PASS |
| 04 | `f496909` | `fix(agent-call): centralize ingress state transitions` | 42 tests | `40-batch-04-evidence.md` | PASS |
| 05 | `e6d11fe` | `feat(runtime): resume harness from durable agent continuations` | 24 tests | `50-batch-05-evidence.md` | PASS |
| 06 | `3e40c6b` | `test(topic-01): consolidate gates and schema evidence` | 94 tests + 静态门禁 | `60-batch-06-evidence.md` | PASS |
| 07 | 本证据提交 | `docs(topic-01): publish final local acceptance evidence` | 完整本地 | `90-final-acceptance.*` | PASS |

Batch 07 修复提交没有藏入原 Batch：`398d711`（Vitest 配置类型）、`20567b4`（全量回归）、`dea7536`（测试收集证据）、`bc934cf`（本地安全门禁不依赖外部审计端点）。

## 5. 原审查问题关闭情况

| 原问题 | 验收 ID | 最终处理 | 生产/测试证据 | 状态 |
|---|---|---|---|---|
| 生产决策缺少真实能力目录 | `CAP-01—CAP-06` | ExecutionBinding 冻结规范目录、摘要、版本与来源 | `lib/runtime/harness-loop/`、Batch 01 tests | PASS |
| `tool.call` 无生产执行器 | `CAP-07—CAP-10` | 统一生产工厂复用 ToolCall 应用服务 | `platform-action-executors.ts`、tool executor tests | PASS |
| 慢 Agent 后父任务无人续跑 | `CONT-01—CONT-09` | Outbox Delivery、租约、8 次退避、dead-letter 与父 Harness 恢复 | `lib/runtime/continuation/`、Batch 05 tests | PASS |
| `waiting_user` 只 warn | `WAIT-01—WAIT-05` | UAR、父 Invocation、Turn 与恢复事实进入持久事务流程 | continuation/user-action tests | PASS |
| External Runtime 丢员工身份 | `SUB-01—SUB-09` | Binding 冻结 Subject，Gateway 只从权威 Binding 恢复 | subject/Gateway integration tests | PASS |
| Ingress 绕过状态机 | `STATE-01—ING-07` | 单一转换服务、CAS、逐事件事务和持久拒绝 | transition/ingress DB tests | PASS |
| AgentCall 重复事实 | `DATA-01—DATA-06` | Binding/Session/Attempt 分别成为 revision/context/task Authority | AgentCall persistence tests | PASS |
| 幂等与来源不干净 | `DATA-07—DATA-10` | 规范 logical key、`harness_planned`、并发唯一与当前 Attempt 解析 | AgentCall authority tests | PASS |
| 逐表必要性证据不足 | `SCHEMA-01—SCHEMA-05` | 120 张表均有 writer/reader 与四方集合证据 | `70-schema-table-inventory.*` | PASS |
| 测试重复与门禁漂移 | `TEST-01—TEST-06` | 414 文件唯一归组，统一 13 阶段入口 | `72-test-collection-audit.json`、`73-verification-plan.json` | PASS |

## 6. 最终 Authority

### Capability Catalog

Dispatcher 在首次执行决策前构建目录，并把规范快照、SHA-256 摘要、版本、来源引用和创建时间持久化到 ExecutionBinding。目录包含 exact Agent Contract、已发布 Tool Operation/Schema/确认要求以及授权 Knowledge 来源；模型视图不包含 Secret。Hosted、External Gateway、Retry 与 Recovery 都从同一 Binding 恢复，服务端使用同一校验器和 executor，拒绝 Runtime 请求体自报能力。

### Trusted Subject

ExecutionBinding 冻结 subject type、stable subject ID、来源和时间。Dispatcher 在缺失或跨租户时 fail closed；External 请求体不是 Subject Authority，Workload Token 绑定 tenant/Runtime/Invocation，Gateway、Hosted 和恢复路径只从 Binding 恢复 Effective Subject。Agent、Tool、Knowledge 共用该主体，审计同时区分 Caller Workload 与 Effective Subject。

### AgentCall

- `AgentCall`：父 Invocation、Harness action、stable Agent、状态、结果、错误和版本。
- `AgentCallBinding`：exact Agent revision、合同、发布、路由、endpoint 和 credential ref。
- `AgentSessionBinding`：A2A context。
- `AgentCallAttempt`：task、attempt number、请求摘要、通道、重试和错误。

AgentCall 主表中的 revision/context/task 重复字段已删除；生产读取不再走旧双轨。

### State/Ingress

`transitionAgentCall` / `applyAgentCallTransition` 是唯一状态转换入口。真实状态变化 CAS 版本精确 `+1`，幂等、映射补全和拒绝不增加版本；终态不可恢复。Ingress 一事件一事务，started 强制 task/context，后续按 task 或唯一活动 Attempt 映射；旧 Attempt 迟到事件不能覆盖当前 Call，拒绝原因提交后可查询，Architecture Gate 阻止旁路写入。

### Continuation

物理基础设施复用 `ControlPlaneOutboxEvent` 与 `ControlPlaneEventDelivery`。Continuation 与状态变化同事务，source version 唯一；Worker 使用 60 秒租约、30 秒续租、固定 8 次退避和 dead-letter。恢复应用服务继续原 Invocation，从 Binding 恢复 Subject、Catalog、Route 与历史；`waiting_user` 及用户回答复用原 AgentCall/Session/Attempt，重复事件与回答幂等。

## 7. Migration 结果

Batch 00 未发现可访问的本地 SnowHarness 数据集，因此迁移前业务行数均为 `not_observed`，没有把未知事实伪写为 0，也未连接生产数据库。迁移 SQL 在 DDL 前对以下冲突 fail closed；Fresh MySQL 8 从空库执行后全部约束通过：

| 项 | 迁移前画像 | Fresh DB 结果 | 验证 |
|---|---|---:|---|
| ExecutionBinding 缺 Subject 的非终态行 | `not_observed` | 0 | PASS |
| AgentCall logical key 为空 | `not_observed` | 0 | PASS |
| revision 冲突 | `not_observed` | 0 | PASS |
| context 冲突 | `not_observed` | 0 | PASS |
| task/Attempt 冲突 | `not_observed` | 0 | PASS |
| AgentCall 旧重复字段 | `present in old schema` | `removed` | PASS |
| 无法恢复的非终态孤儿 | `not_observed` | 0 | PASS |
| Continuation 唯一键冲突 | `not_observed` | 0 | PASS |

没有清理任何生产或未知数据；验证只使用隔离 MySQL。

## 8. Schema 结果

```text
Canonical Root     = 120
Runtime-loaded     = 120
Migration expected = 120
Fresh DB actual    = 120
```

- 四方集合完全一致：`yes`
- 与旧 123 基线的 Delta：`-3`
- 新增表：`none`
- 删除表：`MemoryIndex`、`WorkspaceMergeConflict`、`WorkspaceOverlay`
- 合并表：`none`
- 逐表 Inventory：`70-schema-table-inventory.md/json`
- 无 writer/reader 表：`no`
- 第二 Schema Root：`no`

## 9. 测试收集结果

| 分组 | 文件数 | 测试数 | 是否重复 |
|---|---:|---:|---|
| unit | 271 | 计入 Vitest 总数 | no |
| db | 106 | 计入 Vitest 总数 | no |
| integration | 9 | 计入 Vitest 总数 | no |
| contract | 23 | 计入 Vitest 总数 | no |
| e2e-web | 3 | 13 | no |
| e2e-desktop | 1 | 1 | no |
| e2e-cross-client | 1 | 1 | no |

Vitest 聚合为 `5366 passed / 1 skipped`；该固定 skip 为仓库既有项，本次没有新增 skip。Control Plane 重复 `0`，Desktop Renderer 重复 `0`，纯单元误入 DB 项目 `0`。完整入口为 `pnpm topic01:acceptance`。

## 10. 完整本地验收

| 阶段 | 结果 | 摘要 | 耗时 |
|---|---|---|---:|
| 合同与 Schema | PASS | 63 operations、103 events、93 errors、21 conformance cases；四方 120 表；414 文件唯一归组 | 13.496s |
| Typecheck | PASS | 全仓 TypeScript | 3.456s |
| Vitest | PASS | 408 passed / 1 skipped 文件；5366 passed / 1 skipped 测试 | 1032.181s |
| Lint | PASS | 1366 files；diff check | 2.190s |
| Architecture | PASS | 866 modules、1861 dependencies；Topic 01 gates 全通过 | 4.736s |
| Fresh DB | PASS | migrate → seed → boot；120 表 | 26.202s |
| Web Build | PASS | Next.js production build | 14.151s |
| Desktop Build | PASS | renderer、main、preload、native rebuild | 13.440s |
| Web E2E | PASS | 13/13 | 30.580s |
| Desktop E2E | PASS | 1/1 | 22.957s |
| Cross-client E2E | PASS | 1/1 | 32.853s |
| 本地确定性安全 | PASS | 970 packages；0 forbidden；0 unknown | 0.714s |
| 证据完整性 | PASS | 17 required artifacts + 12 preceding stages | 0.032s |

完整命令、退出码、起止时间和记录 SHA-256 见 `90-final-acceptance.json` 与 `90-final-acceptance.md`。

首次全量没有通过：依次发现 typecheck、Vitest、测试收集证据和外部 audit 端点问题。四次失败均保留，分别由 `398d711`、`20567b4`、`dea7536`、`bc934cf` 修复或正确划定本地验收边界；最终从唯一入口完整重跑并通过。

## 11. 关键场景结果

| # | 场景 | 测试/证据 | 结果 |
|---:|---|---|---|
| 1 | 同一 Thread 连续 4 Turn，Agent 偏好逐 Turn 且历史不改写 | `agent-selection.test.ts`、Cross-client E2E | PASS |
| 2 | preferred Agent 但普通问候可直接 respond | HostedAdapter AgentUseDirective test | PASS |
| 3 | 个人年假查询使用可信员工 Subject | trusted subject、Agent call tests | PASS |
| 4 | External Runtime 使用同一可信 Subject | `external-runtime-subject.integration.test.ts` | PASS |
| 5 | 制度查询只使用授权 Knowledge | Capability Catalog tests | PASS |
| 6 | 邮件行动走生产 ToolCall 服务 | tool executor integration、Gateway tests | PASS |
| 7 | 未授权 Tool 服务端拒绝 | action validation/Gateway tests | PASS |
| 8 | Agent 快速完成，父 Loop 继续且不重复 | harness resume/continuation tests | PASS |
| 9 | Agent 延迟完成后自动恢复父 Invocation | continuation worker integration | PASS |
| 10 | Agent 完成后服务重启仍可恢复 | execution lease/recovery tests | PASS |
| 11 | Agent 补充信息使父 Invocation/Turn 进入 `waiting_user` | agent waiting-user integration | PASS |
| 12 | 用户回答恢复同一 Call/Session/Attempt | invocation continuation DB tests | PASS |
| 13 | Event、Continuation、用户回答重复均幂等 | ingress/continuation/user-action tests | PASS |
| 14 | 终态先于 started 被持久拒绝 | agent-call ingress/transition DB tests | PASS |
| 15 | A2A 事件不能直接完成父 Invocation | start-agent-call、runtime ingress tests | PASS |
| 16 | Fresh DB 启动与最终 Schema 一致 | `db:verify-fresh`、fresh-schema tests | PASS |

## 12. GitHub 与发布说明

```text
GitHub完整CI：not_run_not_required
原因：本工程包明确要求只进行完整本地验收，不触发远端完整CI。
```

Workflow 只复用统一底层脚本：`yes`。分支保护：`out_of_scope`。是否 push：`no`。未运行 GitHub CI 不构成风险豁免，也不影响本工程包 PASS。

## 13. 偏差

```text
计划外偏差：无
未关闭验收ID：无
被豁免阻断项：无
测试跳过：除仓库既有、已解释且与专题01无关的固定skip外，无新增skip
TODO/FIXME阻断路径：无
```

网络依赖审计不属于本地确定性门禁，未写为 PASS：项目镜像没有 audit API，npm 官方端点发生 socket timeout，状态为 `not_run_external_endpoint_unavailable`。`pnpm security:audit` 独立入口保留。

## 14. 剩余非阻断风险

- 真实 HR Agent 业务联调未执行。本专题验证的是 Harness/Agent 边界与协议语义，工程包明确规定该项不阻断；本地没有启动 `/Users/sunshine/IdeaProjects/人力agent/hr-agent`。后续若进行业务联调，只调用已部署的云端 AgentKit。
- GitHub 完整 CI 未运行，状态已按工程包记录为 `not_run_not_required`。
- 外部依赖漏洞审计受网络端点不可用影响未运行；本地许可证与确定性安全门禁已通过，此项没有被伪报为通过。

## 15. 最终签字结论

```text
依据SnowHarness专题01最终封版工程包v1.0：
- 77项验收要求全部通过；
- 完整本地验收全部通过；
- 生产接线、Authority、迁移和持久恢复均有证据；
- GitHub完整CI按约定未运行且不构成阻断；
- 无未关闭P0/P1；
- 无计划外偏差。

专题01主体架构：PASS
专题01最终收口：PASS
专题01状态：CLOSED
```
