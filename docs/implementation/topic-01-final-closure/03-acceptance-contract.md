# Topic 01 验收合同

本文件复制工程包的全部 77 个验收 ID。冻结要求、等级和目标测试编号以 `docs/V12/01/SnowHarness-Topic01-Final-Closure-Engineering-Package/10-ACCEPTANCE-TRACEABILITY-MATRIX.md` 为准；本表是实施期间逐项回填的位置。任何条目缺少生产调用方、定向测试或证据时均不得标记通过。

| ID | 实现位置 | 生产调用方 | 测试位置 | 证据位置 | 状态 |
|---|---|---|---|---|---|
| ARC-01 | `lib/runtime/dispatcher.ts`、`lib/runtime/harness-loop/loop.ts` | Turn API → Dispatcher → Harness Loop | `scripts/topic-01-production-wiring.contract.test.ts`；TS-UX-01 待 Batch 07 | `10-batch-01-evidence.md` | batch_01_pass_pending_final |
| ARC-02 | `lib/runtime/harness-loop/platform-action-executors.ts` | Hosted / External shared executor → `agent-action-executor` | `scripts/topic-01-production-wiring.contract.test.ts` | `10-batch-01-evidence.md` | batch_01_pass_pending_final |
| ARC-03 | 待 Batch 07 回填 | 待回填 | TS-UX-01、TS-UX-02 | 待回填 | pending |
| ARC-04 | 待 Batch 07 回填 | 待回填 | TS-UX-01 | 待回填 | pending |
| ARC-05 | `dispatcher.ts` keeps Runtime binding separate from AgentCall route authority | Turn API / Harness Loop | Batch 02 contract test; TS-ARC-03 pending Batch 05/07 | `20-batch-02-evidence.md` | batch_02_pass_pending_batch_05_07 |
| ARC-06 | 待 Batch 04、05、07 回填 | 待回填 | TS-ARC-04、TS-CONT-01 | 待回填 | pending |
| ARC-07 | 待 Batch 05、07 回填 | 待回填 | TS-CONT-02、TS-CONT-03 | 待回填 | pending |
| ARC-08 | 待 Batch 07 回填 | 待回填 | TS-UX-01、TS-UX-03 | 待回填 | pending |
| CAP-01 | `capability-catalog.ts`、ExecutionBinding 5 个冻结字段、`0001_quick_korvac.sql` | Dispatcher 在首次 Runtime Start 前构建并保存 | `capability-catalog.unit.test.ts`、`capability-catalog.db.test.ts` | `10-batch-01-evidence.md` | pass |
| CAP-02 | `capabilityCatalogModelView`、`HarnessLoop.buildView` | `configuredDecisionPort` 接收同一 Loop view | `capability-catalog.unit.test.ts`、生产接线合同 | `10-batch-01-evidence.md` | pass |
| CAP-03 | `build-production-capability-catalog.ts` | Dispatcher → frozen Policy / enabled Tool / published exact schema | 目录与行动校验测试 | `10-batch-01-evidence.md` | pass |
| CAP-04 | `build-production-capability-catalog.ts` | Dispatcher → tenant active KnowledgeBase | 目录测试 | `10-batch-01-evidence.md` | pass |
| CAP-05 | `verifyCapabilityCatalogSnapshot`、Runtime Start builder | Start、Hosted、External Gateway 均只读 Binding 快照 | 目录篡改与恢复测试 | `10-batch-01-evidence.md` | pass |
| CAP-06 | `validateHarnessActionAgainstCatalog` | Harness Loop 与 Capability Gateway 在执行前调用 | `harness-action-validation.unit.test.ts` | `10-batch-01-evidence.md` | pass |
| CAP-07 | `platform-action-executors.ts` | 共享生产工厂正式注册 `tool.call` | Tool executor 与生产接线合同 | `10-batch-01-evidence.md` | pass |
| CAP-08 | `tool-action-executor.ts`、`execute-harness-tool-call.ts` | `tool.call` → 既有 ToolCall create/state 服务 | Tool executor 与生产接线合同 | `10-batch-01-evidence.md` | pass |
| CAP-09 | Frozen operation/schema/confirmation/idempotency plus Binding subject | Harness Tool executor → ToolCall service | `tool-executor.integration.test.ts`; Batch 02 subject tests | `10-batch-01-evidence.md`, `20-batch-02-evidence.md` | pass |
| CAP-10 | Runtime Start 下发同一快照；Hosted/External 共用校验器与工厂 | In-process Hosted / Runtime API / Capability Gateway | `topic-01-production-wiring.contract.test.ts`；E2E 待 Batch 07 | `10-batch-01-evidence.md` | batch_01_pass_pending_final |
| SUB-01 | ExecutionBinding subject fields and migration | Dispatcher → Binding Repository | `trusted-execution-subject.db.test.ts` | `20-batch-02-evidence.md` | pass |
| SUB-02 | `freezeTrustedExecutionSubject` | `dispatchInvocationForTurn` before Invocation creation | `runtime-dispatch-subject.integration.test.ts` | `20-batch-02-evidence.md` | pass |
| SUB-03 | Start builder has no subject input; capability body is strict | External Runtime → Capability Gateway | `external-runtime-subject.integration.test.ts`; wiring contract | `20-batch-02-evidence.md` | pass |
| SUB-04 | `recoverTrustedExecutionSubject` | Workload Token → Binding → executor | `external-runtime-subject.integration.test.ts` | `20-batch-02-evidence.md` | pass |
| SUB-05 | shared platform action executor | Hosted / External use Binding subject | `topic-01-production-wiring.contract.test.ts` | `20-batch-02-evidence.md` | pass |
| SUB-06 | Retry/Hosted/Command/User Action/Agent Resume recover Binding subject | recovery services and workers | Batch 02 tests; Continuation pending Batch 05 | `20-batch-02-evidence.md` | batch_02_pass_pending_batch_05 |
| SUB-07 | Gateway token tenant/invocation isolation | `resolveGatewayPrincipal` + tenant-scoped Binding | `external-runtime-subject.integration.test.ts` | `20-batch-02-evidence.md` | pass |
| SUB-08 | `capability.action.execute` audit | Capability Gateway → Canonical AuditEvent | `external-runtime-subject.integration.test.ts` | `20-batch-02-evidence.md` | pass |
| SUB-09 | Hosted and External recover the same Binding subject | Hosted launcher / External Gateway | Batch 02 integration; HR Agent E2E pending Batch 07 | `20-batch-02-evidence.md` | batch_02_pass_pending_batch_07 |
| DATA-01 | 待 Batch 03 回填 | 待回填 | TS-DATA-01 | 待回填 | pending |
| DATA-02 | 待 Batch 03 回填 | 待回填 | TS-DATA-02 | 待回填 | pending |
| DATA-03 | 待 Batch 03 回填 | 待回填 | TS-DATA-03 | 待回填 | pending |
| DATA-04 | 待 Batch 03 回填 | 待回填 | TS-DATA-04 | 待回填 | pending |
| DATA-05 | 待 Batch 03 回填 | 待回填 | TS-DATA-05 | 待回填 | pending |
| DATA-06 | 待 Batch 03 回填 | 待回填 | TS-DATA-06 | 待回填 | pending |
| DATA-07 | 待 Batch 03 回填 | 待回填 | TS-DATA-07、TS-DATA-08 | 待回填 | pending |
| DATA-08 | 待 Batch 03 回填 | 待回填 | TS-DATA-09 | 待回填 | pending |
| DATA-09 | 待 Batch 03、04 回填 | 待回填 | TS-DATA-10、TS-ING-04 | 待回填 | pending |
| DATA-10 | 待 Batch 03 回填 | 待回填 | TS-DATA-11 | 待回填 | pending |
| STATE-01 | 待 Batch 04 回填 | 待回填 | TS-STATE-01 | 待回填 | pending |
| STATE-02 | 待 Batch 04 回填 | 待回填 | TS-STATE-02 | 待回填 | pending |
| STATE-03 | 待 Batch 04 回填 | 待回填 | TS-STATE-03 | 待回填 | pending |
| STATE-04 | 待 Batch 04 回填 | 待回填 | TS-STATE-04 | 待回填 | pending |
| ING-01 | 待 Batch 04 回填 | 待回填 | TS-ING-01 | 待回填 | pending |
| ING-02 | 待 Batch 04 回填 | 待回填 | TS-ING-02 | 待回填 | pending |
| ING-03 | 待 Batch 04 回填 | 待回填 | TS-ING-03 | 待回填 | pending |
| ING-04 | 待 Batch 04 回填 | 待回填 | TS-ING-04、TS-ING-05 | 待回填 | pending |
| ING-05 | 待 Batch 04 回填 | 待回填 | TS-ING-06 | 待回填 | pending |
| ING-06 | 待 Batch 04 回填 | 待回填 | TS-ING-07 | 待回填 | pending |
| ING-07 | 待 Batch 04 回填 | 待回填 | TS-CONT-05 | 待回填 | pending |
| CONT-01 | 待 Batch 05 回填 | 待回填 | TS-CONT-01 | 待回填 | pending |
| CONT-02 | 待 Batch 05 回填 | 待回填 | TS-CONT-02 | 待回填 | pending |
| CONT-03 | 待 Batch 05 回填 | 待回填 | TS-CONT-03 | 待回填 | pending |
| CONT-04 | 待 Batch 05 回填 | 待回填 | TS-CONT-04 | 待回填 | pending |
| CONT-05 | 待 Batch 05 回填 | 待回填 | TS-CONT-06 | 待回填 | pending |
| CONT-06 | 待 Batch 05 回填 | 待回填 | TS-CONT-07 | 待回填 | pending |
| CONT-07 | 待 Batch 05 回填 | 待回填 | TS-CONT-08 | 待回填 | pending |
| CONT-08 | 待 Batch 05 回填 | 待回填 | TS-CONT-09 | 待回填 | pending |
| CONT-09 | 待 Batch 05 回填 | 待回填 | TS-CONT-10 | 待回填 | pending |
| WAIT-01 | 待 Batch 05 回填 | 待回填 | TS-WAIT-01 | 待回填 | pending |
| WAIT-02 | 待 Batch 05 回填 | 待回填 | TS-WAIT-02 | 待回填 | pending |
| WAIT-03 | 待 Batch 05 回填 | 待回填 | TS-WAIT-03 | 待回填 | pending |
| WAIT-04 | 待 Batch 05 回填 | 待回填 | TS-WAIT-04 | 待回填 | pending |
| WAIT-05 | 待 Batch 05 回填 | 待回填 | TS-WAIT-05 | 待回填 | pending |
| SCHEMA-01 | 待 Batch 06、07 回填 | 待回填 | TS-SCHEMA-01 | 待回填 | pending |
| SCHEMA-02 | 待 Batch 06 回填 | 待回填 | TS-SCHEMA-02 | 待回填 | pending |
| SCHEMA-03 | 待 Batch 06 回填 | 待回填 | TS-SCHEMA-03 | 待回填 | pending |
| SCHEMA-04 | 待 Batch 06 回填 | 待回填 | TS-SCHEMA-04 | 待回填 | pending |
| SCHEMA-05 | 待 Batch 06 回填 | 待回填 | TS-SCHEMA-05 | 待回填 | pending |
| TEST-01 | 待 Batch 06 回填 | 待回填 | TS-TEST-01 | 待回填 | pending |
| TEST-02 | 待 Batch 06 回填 | 待回填 | TS-TEST-02 | 待回填 | pending |
| TEST-03 | 待 Batch 06 回填 | 待回填 | TS-TEST-03 | 待回填 | pending |
| TEST-04 | 待 Batch 06 回填 | 待回填 | TS-TEST-04 | 待回填 | pending |
| TEST-05 | 待 Batch 06 回填 | 待回填 | TS-TEST-05 | 待回填 | pending |
| TEST-06 | 待 Batch 07 回填 | 待回填 | TS-FINAL-01 | 待回填 | pending |
| FINAL-01 | 待 Batch 07 回填 | 待回填 | TS-FINAL-01 | 待回填 | pending |
| FINAL-02 | 待 Batch 07 回填 | 待回填 | TS-FINAL-02 | 待回填 | pending |
| FINAL-03 | 待 Batch 07 回填 | 待回填 | TS-FINAL-03 | 待回填 | pending |
| FINAL-04 | 待 Batch 07 回填 | 待回填 | TS-FINAL-04 | 待回填 | pending |

## 冻结测试文件规划

每个文件只允许归入一个 Vitest / Playwright 分组；后续如确需改名，必须作为证据偏差记录并同步收集清单。

| Batch | 精确路径 | 唯一分组 |
|---|---|---|
| 01 | `lib/runtime/harness-loop/capability-catalog.unit.test.ts` | unit |
| 01 | `lib/runtime/harness-loop/capability-catalog.db.test.ts` | db |
| 01 | `lib/runtime/harness-loop/harness-action-validation.unit.test.ts` | unit |
| 01 | `lib/runtime/harness-loop/tool-executor.integration.test.ts` | db |
| 01—05 | `scripts/topic-01-production-wiring.contract.test.ts` | unit |
| 02 | `lib/runtime/transport/trusted-execution-subject.unit.test.ts` | unit |
| 02 | `lib/executions/persistence/trusted-execution-subject.db.test.ts` | db |
| 02 | `lib/runtime/runtime-dispatch-subject.integration.test.ts` | db |
| 02 | `app/gateway/v1/capability-actions/external-runtime-subject.integration.test.ts` | db |
| 03 | `lib/agents/calls/application/agent-call-idempotency.unit.test.ts` | unit |
| 03 | `lib/agents/calls/persistence/agent-call-authority.db.test.ts` | db |
| 03 | `lib/agents/calls/persistence/agent-call-binding.db.test.ts` | db |
| 03 | `lib/agents/calls/persistence/agent-call-session-attempt.db.test.ts` | db |
| 03 | `lib/agents/calls/persistence/agent-call-authority-migration.db.test.ts` | db |
| 04 | `lib/agents/calls/application/agent-call-transition.unit.test.ts` | unit |
| 04 | `lib/agents/calls/persistence/agent-call-transition.db.test.ts` | db |
| 04 | `lib/agents/calls/persistence/agent-call-ingress.db.test.ts` | db |
| 04 | `lib/agents/calls/persistence/agent-call-attempt-mapping.db.test.ts` | db |
| 04 | `lib/control-plane/events/continuation-producer.db.test.ts` | db |
| 04 | `scripts/agent-call-state-write-architecture.contract.test.ts` | unit |
| 05 | `lib/control-plane/events/invocation-continuation.db.test.ts` | db |
| 05 | `lib/control-plane/events/invocation-continuation-worker.integration.test.ts` | db |
| 05 | `lib/runtime/harness-loop/harness-resume.integration.test.ts` | db |
| 05 | `lib/runtime/adapters/hosted-adapter-resume.integration.test.ts` | db |
| 05 | `lib/runtime/external-runtime-resume.integration.test.ts` | db |
| 05 | `lib/runtime/harness-loop/agent-waiting-user.integration.test.ts` | db |
| 05 | `lib/conversations/user-action-agent-resume.integration.test.ts` | db |
| 06 | `scripts/topic-01-schema-inventory.contract.test.ts` | unit |
| 06 | `scripts/topic-01-test-collection.contract.test.ts` | unit |
| 06 | `scripts/topic-01-verification-plan.contract.test.ts` | unit |
| 07 | `e2e/topic-01-regression.web.spec.ts` | e2e-web |
| 07 | `e2e/topic-01-regression.desktop.spec.ts` | e2e-desktop |
| 07 | `e2e/topic-01-regression.cross-client.spec.ts` | e2e-cross-client |

HR Agent 不作为本地测试进程启动；明确需要 HR Agent 的 E2E 只调用已部署的云端 AgentKit 服务。
