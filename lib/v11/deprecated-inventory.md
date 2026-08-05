# Deprecated Code Inventory

> §9.3: 已识别的 deprecated 代码。按安全删除优先级排序。

## 已删除 (Phase 3 re-exports)

| 路径 | 删除时间 | 替代路径 |
|------|----------|----------|
| `lib/agents/persistence/control-plane-outbox.ts` | Task 23 | `lib/control-plane/events/control-plane-outbox` |
| `lib/agents/persistence/outbox-relay.ts` | Task 23 | `lib/control-plane/events/outbox-relay` |
| `lib/agents/persistence/outbox-relay-worker.ts` | Task 23 | `lib/control-plane/events/outboxB-relay-worker` |

## 保留 (仍有消费者)

| 路径 | 函数/类型 | 替代 | 消费者数 |
|------|-----------|------|----------|
| `lib/http.ts` | `jsonOk`, `jsonError` | `v11Ok`, `v11Error` | 多处 |
| `lib/http.ts` | `omitThreadSecrets` | V11 投影 | 待确认 |
| `lib/routes/application/deployment-route-service.ts` | `getEffectiveRoutes` | `listEnabledRouteProjections` | 3 测试 |
| `lib/runtimes/domain/runtime-revision-publication-policy.ts` | `ConformanceGateError` | `RuntimeConformanceCaseFailedError` | 2 测试 |
| `lib/runtimes/domain/runtime-revision-publication-policy.ts` | `RuntimePublicationEvidenceSnapshot` | `ArtifactEvidenceSnapshot` | 0 |
| `lib/artifacts/persistence/artifact-record.ts` | `revokedBy`, `revocationReason`, `revokedAt` (column) | 新撤销不修改 | 兼容历史行 |

## Schema 层 deprecated

| 路径 | 说明 |
|------|------|
| `lib/db/schema.ts:257-260` | V8 Skill Run Resolver 字段 |
| `lib/db/schema.ts:492` | V8 allowedTools 边界 |
