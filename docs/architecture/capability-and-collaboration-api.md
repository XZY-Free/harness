# 能力发现与多智能体 API

## 1. 边界结论

本卷补齐两个原先只有领域语义、没有命令协议的部分：员工和 Runtime 如何发现能力，父 Agent 如何受控创建 Child Thread。公共协议、身份、错误格式和幂等规则继承 [api-and-events.md](./api-and-events.md)。

~~~mermaid
flowchart LR
  UI["Desktop / Web 选择器"] --> Options["Catalog Options 员工视图"]
  Loop["Agent Loop"] --> Search["Capability Search Runtime 视图"]
  Search --> Schema["Tool Schema / Skill Content"]
  Schema --> Use["CapabilityUse 实际使用事实"]
  Loop --> Child["Child Thread Command"]
  Child --> Relation["ThreadRelation"]
  Relation --> Result["父 Turn 的 child_thread Item"]
~~~

统一规则：

- 目录查询只返回当前调用者有权使用的能力；无权资源按不存在处理。
- `catalog_revision` 是查询结果缓存游标，不是 Skill/Tool 版本，也不把候选清单锁入 Invocation。
- Tool 真正调用前必须读取 Schema；Skill 真正加载时必须校验 content hash；只有实际加载或调用才写 `CapabilityUse`。
- Runtime 只能使用 Invocation-scoped Workload Identity，不能代表员工新增、发布或授权能力。
- Child Thread 只允许从活跃父 Invocation 创建；子 Agent、上下文、预算和深度都由平台重新校验。

业务例子：员工在输入区先看到财务 Agent 可用的 Skill；Agent 执行时又按任务搜索到 ERP 查询 Tool。目录列出 Tool 不等于已经使用，直到 Runtime 读取 Schema 并调用时才记录 `CapabilityUse`。

## 2. Employee Catalog API

### 2.1 查询任务输入区选项

`GET /api/v1/catalog/options`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| agent_id | Query | string | 否 | 已选 Agent；传入后计算本次可追加能力 |
| thread_id | Query | string | 否 | 已有 Thread 场景；用于 Workspace、主 Agent 和策略上下文 |
| capability_types | Query | string[] | 否 | agent、skill、model、environment；默认返回任务输入区全部类型 |
| query | Query | string | 否 | 名称、描述和标签搜索，最大 200 字符 |
| cursor | Query | string | 否 | 不透明分页游标 |
| limit | Query | integer | 否 | 1—100，默认 30 |
| If-None-Match | Header | string | 否 | 上次 `catalog_revision` 对应 ETag |

```bash
curl 'https://snow.example.com/api/v1/catalog/options?agent_id=agt_finance&capability_types=skill&query=报表&limit=30' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'If-None-Match: "catalog-tenant-audience-184"'
```

```json
{
  "catalog_revision": "catalog-tenant-audience-185",
  "items": [
    {
      "type": "skill",
      "id": "skill_report_review",
      "display_name": "报表复核",
      "description": "检查报表口径和异常值",
      "selectable": true,
      "disabled_reason_code": null,
      "badges": ["只读"]
    }
  ],
  "next_cursor": null
}
```

响应 ETag 与 `catalog_revision` 一致。资源存在但当前 Agent 不支持动态 Skill 时，可以返回员工本来有权查看的选项并设置 `selectable=false`、`disabled_reason_code=AGENT_CAPABILITY_UNSUPPORTED`；资源本身无权访问时不返回。304 表示该受众目录未变化。

## 3. Runtime Capability API

### 3.1 搜索可用能力

`POST /gateway/v1/capabilities/search`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | 本次模型决策内搜索幂等键 |
| invocation_id | Body | string | 是 | 必须等于 Workload Identity 绑定的 Invocation |
| query | Body | string | 是 | 任务意图，不接受隐藏身份或 Credential |
| capability_types | Body | string[] | 否 | skill、tool、knowledge、agent、model；默认由 AgentRevision 允许范围决定 |
| required_features | Body | string[] | 否 | 结构化要求，如 read_only、tabular_input |
| limit | Body | integer | 否 | 1—50，默认 20 |
| catalog_revision | Body | string | 否 | Runtime 已知目录修订，只用于差异和缓存提示 |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/capabilities/search' \
  -H 'Authorization: Bearer <invocation-workload-token>' \
  -H 'Idempotency-Key: inv-42-capability-search-3' \
  -H 'Content-Type: application/json' \
  -d '{"invocation_id":"inv_01J...","query":"读取销售明细并检查异常值","capability_types":["skill","tool"],"required_features":["read_only"],"limit":10}'
```

```json
{
  "catalog_revision": "catalog-tenant-runtime-441",
  "items": [
    {
      "type": "tool",
      "id": "tool_sales_query",
      "display_name": "销售明细查询",
      "current_revision_id": "tsr_12",
      "schema_hash": "sha256:9d...",
      "risk_summary": {"effect":"read","data_class":"internal"},
      "selection_reason_code": "SEMANTIC_MATCH",
      "schema_url": "/gateway/v1/tools/tool_sales_query/schema"
    },
    {
      "type": "skill",
      "id": "skill_anomaly_review",
      "display_name": "异常值复核",
      "current_revision_id": "sv_8",
      "content_hash": "sha256:31...",
      "selection_reason_code": "AGENT_DEFAULT_PLUS_QUERY",
      "content_url": "/gateway/v1/skills/skill_anomaly_review/content"
    }
  ]
}
```

搜索本身写 Trace selection span，但不写 `CapabilityUse`。返回结果已经按 AgentRevision 委派范围、当前用户、租户、环境和 Policy 过滤；Runtime 不能通过增加 query 绕过这些条件。

### 3.2 读取 Tool Schema

`GET /gateway/v1/tools/{tool_id}/schema`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| tool_id | Path | string | 是 | 稳定 Tool id，不接受展示名称 |
| invocation_id | Query | string | 是 | 当前 Invocation |
| revision_id | Query | string | 否 | 重放已开始 ToolCall 时读取指定修订；新调用省略并读取当前修订 |
| If-None-Match | Header | string | 否 | 已缓存 schema hash |

```bash
curl 'https://snow.example.com/gateway/v1/tools/tool_sales_query/schema?invocation_id=inv_01J...' \
  -H 'Authorization: Bearer <invocation-workload-token>' \
  -H 'If-None-Match: "sha256:old"'
```

```json
{
  "tool_id": "tool_sales_query",
  "schema_revision_id": "tsr_12",
  "schema_hash": "sha256:9d...",
  "description": "按日期和组织范围查询销售明细",
  "input_schema": {
    "type": "object",
    "required": ["date_from", "date_to"],
    "properties": {
      "date_from": {"type":"string","format":"date"},
      "date_to": {"type":"string","format":"date"}
    },
    "additionalProperties": false
  },
  "output_schema": {"type":"object"},
  "risk_summary": {"effect":"read","data_class":"internal"},
  "expires_at": "2026-07-15T02:00:00.000Z"
}
```

成功读取并进入模型可用工具集时，平台按 `(invocation_id, tool_id, schema_revision_id, schema_hash)` 幂等写 `CapabilityUse`。调用阶段提交的 schema hash 不一致返回 `TOOL_SCHEMA_CHANGED`，Runtime 重新读取后再生成参数；进行中的 ToolCall 不换 Schema。

### 3.3 读取 Skill 内容

`GET /gateway/v1/skills/{skill_id}/content`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| skill_id | Path | string | 是 | 稳定 Skill id |
| invocation_id | Query | string | 是 | 当前 Invocation |
| version_id | Query | string | 否 | 合规重放或显式固定时使用；普通动态加载省略 |
| If-None-Match | Header | string | 否 | 已缓存 content hash |

```bash
curl 'https://snow.example.com/gateway/v1/skills/skill_anomaly_review/content?invocation_id=inv_01J...' \
  -H 'Authorization: Bearer <invocation-workload-token>' \
  -H 'If-None-Match: "sha256:30..."'
```

```json
{
  "skill_id": "skill_anomaly_review",
  "skill_version_id": "sv_8",
  "content_hash": "sha256:31...",
  "media_type": "text/markdown",
  "content": "# 异常值复核\n\n先确认统计口径……",
  "source_type": "dynamic_discovery",
  "expires_at": "2026-07-15T02:00:00.000Z"
}
```

成功返回内容时幂等写 `CapabilityUse`。内容超过 Gateway 上限时返回短期受控 `content_ref` 和相同 hash，Runtime 仍必须在使用前校验完整内容 hash。Skill 不得携带 Secret；违反内容扫描策略返回 `CAPABILITY_CONTENT_BLOCKED`。

## 4. Child Thread Command API

### 4.1 创建委派 Child Thread

`POST /gateway/v1/child-threads`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | 父 Invocation 内委派幂等键 |
| parent_invocation_id | Body | string | 是 | 必须为 running 的会话 Invocation |
| target_agent_id | Body | string | 是 | 父 AgentRevision 允许委派且当前员工有权使用的 Agent |
| task | Body | object | 是 | `title`、`instructions`、`expected_output_schema`；不得复制完整 Thread |
| context_transfer | Body | object | 是 | mode 为 task_only、recent、full；列出允许的 item_ids、artifact_ids |
| budget | Body | object | 是 | max_tokens、max_cost、max_tool_calls、deadline_at；不得超过父剩余预算 |
| execution_preference | Body | object | 否 | 可请求环境类型；平台重新决策实际环境 |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/child-threads' \
  -H 'Authorization: Bearer <invocation-workload-token>' \
  -H 'Idempotency-Key: inv-42-delegate-risk-review' \
  -H 'Content-Type: application/json' \
  -d '{"parent_invocation_id":"inv_01J...","target_agent_id":"agt_risk","task":{"title":"复核销售报表","instructions":"只检查异常值并给出证据","expected_output_schema":{"type":"object","required":["conclusion","evidence"]}},"context_transfer":{"mode":"task_only","item_ids":["item_report_request"],"artifact_ids":["art_sales_report"]},"budget":{"max_tokens":12000,"max_cost":"5.00 CNY","max_tool_calls":8,"deadline_at":"2026-07-15T02:00:00.000Z"}}'
```

```json
{
  "relation_id": "rel_01J...",
  "parent_thread_id": "thr_parent",
  "child_thread_id": "thr_child",
  "child_turn_id": "turn_child_1",
  "child_invocation_id": "inv_child_1",
  "relation_state": "active",
  "accepted_budget": {"max_tokens":12000,"max_cost":"5.00 CNY","max_tool_calls":8},
  "event_ids": ["evt_parent_child_created","evt_child_thread_created"]
}
```

服务端在受控应用命令中创建 child Thread、ThreadRelation、子 Turn/user_message 等价的 system task Item、子 Invocation 和父 `child_thread` Item，并向父子各分配独立 Event sequence。`context_transfer.mode=full` 需要明确 Policy 许可；Credential、隐藏思维链和未授权本地路径始终不转移。超过委派深度返回 `DELEGATION_DEPTH_EXCEEDED`，预算超过父剩余额度返回 `CHILD_BUDGET_EXCEEDED`。

### 4.2 查询 Child Thread 状态和结果

`GET /gateway/v1/child-threads/{child_thread_id}`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| child_thread_id | Path | string | 是 | 子 Thread id |
| parent_invocation_id | Query | string | 是 | 创建该关系的父 Invocation |

```bash
curl 'https://snow.example.com/gateway/v1/child-threads/thr_child?parent_invocation_id=inv_01J...' \
  -H 'Authorization: Bearer <invocation-workload-token>'
```

```json
{
  "relation_id": "rel_01J...",
  "child_thread_id": "thr_child",
  "relation_state": "completed",
  "result": {
    "result_ref": "result:child-thread:rel_01J...:1",
    "result_hash": "sha256:aa...",
    "summary": "发现 3 项异常，均已附证据",
    "artifact_ids": ["art_risk_report"],
    "completed_at": "2026-07-15T01:25:00.000Z"
  },
  "budget_used": {"tokens":8421,"cost":"2.70 CNY","tool_calls":5}
}
```

父 Runtime 只能读取结构化结果和允许的 Artifact，不读取子 Thread 全部消息。完成投影由平台根据子 Thread 终态生成并幂等更新父 `child_thread` Item；子 Runtime 不能直接回写父 Thread。

### 4.3 请求取消 Child Thread

`POST /gateway/v1/child-threads/{child_thread_id}/cancel`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| child_thread_id | Path | string | 是 | 子 Thread id |
| Idempotency-Key | Header | string | 是 | 取消命令幂等键 |
| parent_invocation_id | Body | string | 是 | 创建关系的父 Invocation |
| reason_code | Body | string | 是 | PARENT_NO_LONGER_NEEDS_RESULT、PARENT_CANCELLED、BUDGET_EXHAUSTED |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/child-threads/thr_child:cancel' \
  -H 'Authorization: Bearer <invocation-workload-token>' \
  -H 'Idempotency-Key: inv-42-cancel-child-risk-review' \
  -H 'Content-Type: application/json' \
  -d '{"parent_invocation_id":"inv_01J...","reason_code":"PARENT_NO_LONGER_NEEDS_RESULT"}'
```

```json
{
  "relation_id": "rel_01J...",
  "child_thread_id": "thr_child",
  "relation_state": "cancel_requested",
  "command_id": "cmd_child_cancel_01J...",
  "requested_at": "2026-07-15T01:20:00.000Z"
}
```

请求成功不等于已取消。平台向子 Invocation 写 cancel command；Runtime 确认后关系才变为 cancelled 并在父子流分别写 `child_thread.cancelled`。子任务已完成时返回当前 completed 结果；存在 `unknown_effect` 时保留核对责任，不把关系伪造成无副作用取消。

## 5. Handoff 统一规则

主 Agent 交接不新增 Child Thread 命令，也不新增独立交接请求表：

1. Workflow/Runtime 调用 [发起用户操作请求](./api-and-events.md#55-发起用户操作请求)，提交 `request_type=confirmation`、`purpose=handoff` 和目标 Agent。
2. 平台创建 user_action_request Item，写 `handoff.requested` 与 `user_action.requested`，当前 Invocation 进入 waiting_user。
3. 员工通过 [解析用户操作请求](./api-and-events.md#318-解析用户操作请求) 接受或拒绝。
4. 接受时由 Employee Application Service 原子更新 `thread.primary_agent_id`，写 `thread.primary_agent_changed`、`handoff.completed`；拒绝只写解析结果并恢复原 Invocation。

业务例子：风险审核子任务完成不代表风险 Agent 接管会话；只有员工在明确提示中确认，主 Agent 才从财务 Agent 改为风险 Agent。

## 6. 稳定错误码

| 错误码 | HTTP | 含义 |
|---|---:|---|
| CATALOG_REVISION_INVALID | 400 | 目录 revision 格式或受众不匹配 |
| AGENT_CAPABILITY_UNSUPPORTED | 422 | AgentRevision 不支持该动态能力类型 |
| CAPABILITY_NOT_ALLOWED | 404 | 当前 Invocation 无权发现或使用该能力 |
| CAPABILITY_CONTENT_BLOCKED | 422 | Skill 内容违反安全策略 |
| TOOL_SCHEMA_CHANGED | 409 | 调用提交的 Schema hash 已不是读取时版本 |
| PARENT_INVOCATION_NOT_ACTIVE | 409 | 父 Invocation 不允许再创建委派 |
| DELEGATION_NOT_ALLOWED | 403 | AgentRevision 或 Policy 不允许目标 Agent |
| DELEGATION_DEPTH_EXCEEDED | 422 | 超过最大 Child Thread 深度 |
| CHILD_BUDGET_EXCEEDED | 422 | 子预算超过父任务剩余额度 |
| CHILD_CONTEXT_NOT_ALLOWED | 403 | 请求传递的 Item/Artifact/Scope 越权 |
| CHILD_THREAD_ALREADY_TERMINAL | 409 | 对终态 Child Thread 发送了不兼容命令 |

## 7. 验收场景

| 场景 | 通过条件 |
|---|---|
| 目录列出但未使用 Tool | 只有搜索 Trace，没有 CapabilityUse |
| Tool Schema 在搜索后更新 | 调用前读取当前 Schema；旧 hash 被拒绝，不修改已开始 ToolCall |
| Skill 动态加载 | AgentRevision 不变；CapabilityUse 保存实际 version/hash |
| 未授权能力猜 id | 返回 404，响应不泄露资源类型、负责人或版本 |
| 重放 Child Thread 创建 | 相同幂等键返回相同 relation/child Thread，不重复执行 |
| Child Thread 结果 | 父 Turn 只出现一个 child_thread Item 和结构化结果引用 |
| 取消子任务 | 先 cancel_requested，Runtime ack 后才 cancelled |
| Workflow 请求交接 | 使用 UserActionRequest；员工拒绝时主 Agent 不变 |
