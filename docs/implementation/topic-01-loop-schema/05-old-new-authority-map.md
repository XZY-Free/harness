# 最终 Schema Authority 映射

> 状态：2026-08-31 已实施。本文只描述当前可运行事实，不保留开发期兼容路径。

## 旧表收口结果

| 已删除表 | 处理 | 唯一正式 Authority |
|---|---|---|
| `User` | merge/delete | `UserIdentity` + `PrincipalBinding` |
| `AdminAuditLog` | merge/delete | `AuditEvent` |
| `ToolRun` | delete | `ToolCall` + `EffectRecord` + `Artifact` |
| `ContextSnapshot` / `ContextSummary` | delete | `ContextCheckpoint` + Trace/Observation |
| `ThreadPlan` / `ThreadPlanItem` | delete | Harness action history + `Goal` |
| `GitCheckpoint` | delete | `FilesystemCheckpoint` |
| `McpServerConfig` / `CustomTool` | delete | `Connection` + `ToolProvider` + `Tool` + `ToolSchemaRevision` |
| `SecretMount` | delete | `CredentialRef` + 外部 Credential Provider |
| `Deployment` | delete | `HostedProvisioningRequest` + `PublicationRecord` + `RouteActivation` + `Artifact` |
| `AuditFailureLog` | delete | `ControlPlaneOutboxEvent` + `ControlPlaneEventDelivery` / `EventDeliveryFailure` |

上述表、`lib/db/schema.ts`、`lib/db/queries.ts` 及对应旧 writer/consumer 均已物理删除，不存在双写或只读兼容层。

## Schema 入口

| 入口 | 当前事实 |
|---|---|
| `drizzle.config.ts` | 只读取 `lib/persistence/schema/index.ts` |
| `lib/db/client.ts` | 只将 Canonical Root 交给 Runtime Drizzle |
| `lib/db/test/mysql-harness.ts` | 使用同一 Canonical Root |
| `drizzle/0000_initial_schema.sql` | 从最终 Root 生成的单一 clean initial migration |

Root、Runtime、Migration 与 Fresh MySQL 均为 123 张业务表，精确表名见 `07-final-schema-manifest.json`。

## AgentCall 字段 Authority

- exact revision → `AgentCallBinding.agentRevisionId`
- A2A contextId → `AgentSessionBinding.externalContextRef`
- A2A taskId → `AgentCall.externalTaskRef`

`AgentCall.agentSessionBindingId` 是 context Authority 的外键，不复制 contextId；`AgentCallAttempt` 不复制 taskId。
