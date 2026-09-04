# Tool Permission Authority 与 Provider 执行修复记录

- 起点 SHA：`f4d7534`
- 本批生产修复终点 SHA：`577c629`
- 关闭问题：`P0-02`、`P1-07`
- 残留 TODO：`0`

## 文件变化

本批修改了：

- Hosted Harness 与 External Runtime 共用的 canonical Tool application service。
- Tool Capability Catalog、权限判断、状态机、Effect reconcile 与 continuation。
- Tool SchemaRevision 执行合同及其发布接口。
- canonical schema、clean initial migration、Drizzle snapshot 与 schema manifest。
- Tool/Provider/Effect/Continuation 的定向测试与 architecture gate。

本批新增了：

- `lib/capability/application/apply-tool-call.ts`
- `lib/capability/tool-execution-contract.ts`
- `lib/capability/provider-executor.ts`
- `lib/capability/tool-execution-queries.ts`
- `lib/capability/tool-execution-worker.ts`
- `lib/persistence/schema/tool-execution.ts`
- `scripts/workers/tool-execution-worker.ts`

删除文件：无。

## Schema 与 Migration

- canonical schema 共 `122` 张表。
- 新增 `ToolExecutionBinding`，一对一冻结 Provider、Connection、CredentialRef、executor 与 execution contract digest。
- 新增 `ToolExecutionAttempt`，按 attemptNo 记录 claim、dispatch、结果、重试分类与 lease。
- `ToolSchemaRevision` 新增不可空 `executionContractJson` 与 `executionContractDigest`。
- `ToolCall` 新增真实 `queued` 状态；`running` 只在 worker 已创建真实 attempt 后出现。
- 变更已压入 `drizzle/0000_initial_schema.sql`，未新增补丁 migration。

## Authority 与执行变化

- Catalog 不再用空 arguments 评估最终权限，也不再输出 `confirmation` 授权语义。
- Hosted Harness 和 Gateway 都调用 `applyToolCall`；只有该服务能按 actual arguments 创建 PermissionDecision、UAR、ToolCall 与 ToolExecutionBinding。
- actual arguments 先按 exact published schema 校验；credential/secret 字段 fail-closed；幂等摘要使用 RFC 8785 规范 JSON。
- 当前唯一 production executor 是 `webhook/webhook.post_json`；未实现 provider 不进入可执行 Catalog。
- Webhook 生产只允许 HTTPS；认证仅从冻结 CredentialRef 解析；响应限流、超时与递归脱敏由 execution contract 执行。
- write Tool 在 dispatch 前创建 EffectRecord 和稳定 external idempotency key；partial 不再伪装 succeeded。
- 无幂等保障的未知副作用进入 `unknown_effect`，禁止自动重放；安全 transient 重试沿用同一 key。
- Tool terminal、Attempt、Effect 与 durable continuation 同事务提交；终态已落库但 continuation 缺失时可补发。
- continuation 恢复同一个 parent Invocation，worker 不直接完成父 Invocation。

## 最终生产调用链

```text
Hosted Harness / External Runtime
→ canonical applyToolCall
→ frozen Catalog + exact ToolSchemaRevision
→ actual arguments schema validation
→ frozen PolicyRevision + PermissionDecision
→ ToolCall + immutable ToolExecutionBinding
→ durable Tool worker + ToolExecutionAttempt
→ real webhook Provider
→ Effect reconcile + ToolCall terminal
→ durable continuation
→ same parent Invocation resume
```

## 定向验证

- unit：`44 passed`。
- integration：`9 passed`。
- db：`129 passed`。
- contract：`9 passed`。
- `pnpm typecheck`：通过。
- `pnpm architecture:gate`：通过。
- `pnpm topic01:tests:audit`：通过，共登记 `417` 个测试文件。
- 变更文件 Biome 与 `git diff --check`：通过。

本批未运行全仓 Vitest、Playwright、Fresh DB 和 `pnpm topic01:acceptance`；按修复方案统一留到批次 07。
