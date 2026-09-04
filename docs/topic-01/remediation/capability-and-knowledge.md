# Capability Catalog Authority 与 Knowledge ACL 修复记录

- 起点 SHA：`24a8d97b26270100d908b8f6d6c81d019324525e`
- 本批生产修复终点 SHA：`ac455f0`
- 关闭问题：`P0-01`、`P1-06`
- 残留 TODO：`0`

## 文件变化

修改文件：

- Agent Contract 解析、登记、发布 digest 重算与快照 Schema。
- Capability Catalog 构建、模型投影与 Harness 类型。
- Knowledge 查询、Context Query Gateway、Harness Platform Executor。
- canonical schema、clean initial migration、Drizzle snapshot。
- Topic01 architecture gate 与定向测试。

新增文件：

- `lib/context/knowledge-acl.ts`
- `lib/context/knowledge-access.db.test.ts`

删除文件：无。

## Schema 与 Migration

`AgentContractSnapshot` 新增不可空字段：

- `scenarioDeclaration`：`declared | unspecified`
- `applicableScenarios`
- `excludedScenarios`

canonical schema、`drizzle/0000_initial_schema.sql` 和 `drizzle/meta/0000_snapshot.json` 已同步。本批未新增补丁 migration。

## Authority 变化

- Agent 场景：由 `AgentContractSnapshot` 中的显式 scenario 声明唯一决定；删除 Agent 名称、capability description 和 examples 推断。
- Knowledge 可见性：由 `ExecutionBinding` 恢复的 Trusted Subject 与 `KnowledgeDocumentRevision` 冻结 ACL snapshot 唯一决定。
- Capability Catalog：只冻结对 Trusted Subject 可发现的 KnowledgeBase id，不复制 ACL。

## 最终生产调用链

```text
ExecutionBinding Subject
→ Knowledge discovery ACL
→ frozen Capability Catalog scope
→ knowledge.search
→ Revision ACL hash/schema/subject authorization
→ authorized Revision ids
→ Chunk query/rank/redacted observation
```

```text
AgentRevision
→ exact AgentContractSnapshot
→ scenarioDeclaration/applicableScenarios/excludedScenarios
→ Capability Catalog
```

## 定向验证

- Agent Contract、Capability Catalog、Harness action、Gateway、Knowledge ACL、发布 digest、Schema 与 architecture gate：`158 passed`。
- Runtime dispatcher 关联回归：`36 passed`。
- `pnpm typecheck`：通过。
- `pnpm architecture:gate`：通过。

本批未运行全仓 Vitest、Playwright、Fresh DB 和 `pnpm topic01:acceptance`；按修复方案统一留到批次 07。
