# Topic 01 最终复核清单

> 本文件只预填实现位置，不写 Batch 07 结果。最终通过/失败以 `90-final-acceptance-result.json` 和 Batch 07 报告为准。

| 复核项 | 实现位置 | 最终结果 |
|---|---|---|
| 合同与 Schema 生成一致性 | `scripts/topic-01-schema-evidence.mts`、`70-schema-table-inventory.json` | 待 Batch 07 |
| 可信执行 Subject | `lib/runtime/transport/execution-subject.ts`、ExecutionBinding | 待 Batch 07 |
| 生产 Capability Catalog 与 `tool.call` | `lib/runtime/harness-loop/` | 待 Batch 07 |
| AgentCall revision/context/task Authority | `lib/persistence/schema/agent-calls.ts` | 待 Batch 07 |
| AgentCall 唯一 ingress transition | `lib/agents/calls/persistence/apply-agent-call-transition.ts` | 待 Batch 07 |
| Durable continuation 与 8 次退避 | `lib/runtime/continuation/`、Control Plane Outbox Worker | 待 Batch 07 |
| Hosted 恢复继续执行 Harness Loop | `lib/runtime/adapters/hosted-adapter.ts` | 待 Batch 07 |
| 测试唯一分组 | `72-test-collection-audit.json`、`vitest.config.ts` | 待 Batch 07 |
| 13 阶段统一验收 | `73-verification-plan.json`、`scripts/topic-01-acceptance.mjs` | 待 Batch 07 |
| Fresh DB、Web/Desktop build 与三类 E2E | `scripts/verify-fresh-db.mts`、Playwright stage runner | 待 Batch 07 |
| 安全与证据完整性 | `security:check`、`scripts/topic-01-evidence-integrity.mjs` | 待 Batch 07 |
