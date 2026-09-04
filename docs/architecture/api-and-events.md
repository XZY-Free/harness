# API 与 Event 边界

> 本卷保存 Thread/Turn/Item、Runtime 基础协议、Gateway 基础能力、Admin 发布与 Event 的基础接口。为避免继续扩大单文件，能力发现与 Child Thread 命令见 [capability-and-collaboration-api.md](./capability-and-collaboration-api.md)，Memory/Job 命令见 [memory-and-job-api.md](./memory-and-job-api.md)，生产运维、安全和数据生命周期见 [security.md](./security.md)。全部接口由 [机器契约](./contracts-and-conformance.md) 统一生成 OpenAPI 并校验。

## 1. 边界结论

不提供一个既能聊天、又能改 Agent 配置、还能让 Runtime 直写数据库的万能 API。接口分为四组：

| 边界 | 调用方 | 职责 | 明确禁止 |
|---|---|---|---|
| Employee Interaction API（员工交互接口） | Desktop、Web | Thread、Turn、Item、Event、PendingInput、用户操作 | 修改 Agent Revision、伪造 Runtime Event |
| Runtime Protocol（运行时协议） | 托管或外部 Runtime Adapter | 接收 Invocation、回传规范事件、取消执行 | 直写 Thread/Item/Event 表、读取平台 Secret |
| Admin Control API（管理控制接口） | 管理后台、CI/CD | Agent、Runtime、Route、能力、知识、策略和连接 | 代替员工发送聊天消息 |
| Gateway API（内部网关接口） | 可信 Runtime | Tool、Context、Credential、Artifact 和 Policy | 向模型返回 Credential 原值 |

~~~mermaid
flowchart LR
  Desktop["Desktop"] --> Employee["Employee Interaction API"]
  Web["Web"] --> Employee
  Admin["管理后台 / CI/CD"] --> Control["Admin Control API"]
  Employee --> Core["Thread / Turn / Item / Event"]
  Core --> Dispatcher["Invocation Dispatcher"]
  Dispatcher --> Runtime["Hosted / External Runtime Adapter"]
  Runtime --> Ingress["Runtime Event Ingress"]
  Ingress --> Core
  Runtime --> Gateway["Tool / Context / Credential Gateway"]
  Control --> Config["Agent / Runtime / Route / Capability / Policy"]
  Config --> Dispatcher
~~~

业务例子：Desktop 创建 Turn 后只订阅 SnowHarness Event；VeADK 或 Claude/Codex Adapter 接收 Invocation 并回传规范化 Event；管理员发布 AgentRevision 走 Admin API。外部 Runtime 不需要理解 SnowHarness 数据表，也不能用管理员令牌操作员工会话。

## 2. 公共协议

### 2.1 路径与版本

~~~text
/api/v1/...                 员工交互接口
/runtime/v1/...             Runtime 协议
/admin/api/v1/...           管理控制与观测接口
/gateway/v1/...             Runtime 到平台的内部网关
~~~

URL 中的 `v1` 表示资源和命令语义版本。Event payload 另有 `schema_version`，允许在不更换整个 API 版本时演进单个事件。

### 2.2 身份与授权

| 接口 | 身份 |
|---|---|
| Employee API | 员工 SSO Session/OAuth Token；Desktop 另带设备签名 |
| Runtime Protocol | 短期 Workload Identity，绑定 runtime_revision、invocation 和租户 |
| Admin API | 管理员 SSO + RBAC，CI/CD 使用受限 Service Identity |
| Gateway API | Invocation-scoped Workload Identity，只能访问 ExecutionBinding 允许的资源 |

`user_id`、`tenant_id`、`credential_ref` 和权限上下文从身份中解析，不能信任模型在 JSON 参数中提交的同名字段。

### 2.3 公共请求头

| 请求头 | 适用 | 说明 |
|---|---|---|
| Authorization | 全部 | Bearer Token 或平台 Session |
| Idempotency-Key | 所有创建和命令 POST | 同一调用方、Scope 与请求体重放返回同一结果 |
| If-Match | 可编辑资源 PUT/PATCH | 值为资源 ETag；冲突返回 412 |
| X-Request-ID | 全部 | 调用方请求 id；平台未收到时生成 |
| Last-Event-ID | Thread/Job Event SSE | 上次已处理的十进制流内 event_sequence |
| X-Desktop-Device-ID / X-Desktop-Signature | Desktop 本地资源操作 | 设备绑定与请求签名 |

Idempotency-Key 至少保留到该命令不可能被客户端合理重放；有副作用 ToolCall 的 `operation_id` 按目标系统业务周期保留，二者不是同一个字段。

平台用 `idempotency_record` 保存 caller、command_scope、request_hash 和原响应引用，并与首个业务写入同事务提交。同 key 不同请求体返回 409；ThreadEvent.idempotency_key 不能替代这份跨 Employee/Runtime/Gateway/Admin 的命令账本。

### 2.4 时间、分页和并发

- 时间使用 RFC 3339 UTC，如 `2026-07-15T01:23:45.123Z`。
- 列表使用不透明 `cursor`，不让客户端拼接数据库 offset。
- 响应包含 `ETag` 的资源必须使用 `If-Match` 更新。
- ID 是不透明 UUID 字符串；客户端不能从 UUID 排序或推断租户。示例中的 `thr_01J...` 等是为阅读缩短的占位写法，不是字面生产值。
- 删除默认是受控命令，不把 `DELETE` 等同于立即物理清理。

### 2.5 成功与错误格式

普通资源响应直接返回资源；异步命令返回当前状态和可跟踪 id。错误统一为：

```json
{
  "error": {
    "code": "TURN_ALREADY_TERMINAL",
    "message": "本轮已结束，不能再引导",
    "request_id": "req_01J...",
    "retryable": false,
    "details": {
      "turn_id": "turn_01J...",
      "turn_state": "completed"
    }
  }
}
```

| HTTP 状态 | 使用场景 |
|---|---|
| 400 | Schema 或命令语义错误 |
| 401 / 403 | 未认证 / 无权访问 |
| 404 | 资源不存在或为防越权而隐藏 |
| 409 | 当前状态与命令冲突，例如重复解析确认 |
| 412 | ETag/If-Match 不一致 |
| 422 | 参数合法但业务约束不满足 |
| 429 | 配额或并发限制 |
| 503 | 暂时无可用 Runtime，允许按 retry_after 重试 |

## 3. Employee Interaction API

### 3.1 创建 Thread

`POST /api/v1/threads`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | 创建幂等键 |
| title | Body | string | 否 | 未传时由首个 Turn 生成 |
| workspace_id | Body | string | 否 | 默认逻辑 Workspace |
| parent | Body | object | 否 | 仅 fork/delegate 的受控入口使用；普通创建不传 |

```bash
curl -X POST 'https://snow.example.com/api/v1/threads' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: 018f-create-report-thread' \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"ws_sales"}'
```

```json
{
  "id": "thr_01J...",
  "default_workspace_id": "ws_sales",
  "lifecycle_state": "active",
  "last_event_sequence": 1,
  "created_at": "2026-07-15T01:00:00.000Z"
}
```

服务端同时写入 Thread 和 `thread.created` Event。创建 Thread 不要求、也不校验任何 Agent；Agent 目录为空时仍可正常创建 Thread。

### 3.2 更新 Thread 默认设置

`PATCH /api/v1/threads/{thread_id}/settings`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | Thread id |
| If-Match | Header | string | 是 | Thread 设置 ETag |
| default_model_ref | Body | string/null | 否 | 下一个新 Invocation 的模型偏好 |
| default_workspace_id | Body | string/null | 否 | 默认逻辑 Workspace |
| default_environment_definition_id | Body | string/null | 否 | 默认环境偏好，不是实际 Lease |

```bash
curl -X PATCH 'https://snow.example.com/api/v1/threads/thr_01J.../settings' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'If-Match: "thread-settings-8"' \
  -H 'Content-Type: application/json' \
  -d '{"default_model_ref":"model:doubao-pro","default_environment_definition_id":"env_desktop_default"}'
```

```json
{
  "thread_id": "thr_01J...",
  "default_model_ref": "model:doubao-pro",
  "default_environment_definition_id": "env_desktop_default",
  "applies_to_new_invocations": true,
  "event_ids": ["evt_model_changed","evt_environment_changed"],
  "etag": "\"thread-settings-9\""
}
```

实际模型和 Lease 仍以 ExecutionBinding 为准；当前等待恢复的 Invocation 不因默认设置变化换 Binding。

### 3.3 Agent 选择是 Turn 级指令

Thread 不保存主 Agent，也不保存 primary/default/current/active/preferred Agent 字段。客户端必须在每个新 Turn 的 `agent_use` 中显式发送“优先助手”；省略或 `null` 都表示本 Turn 无 Agent 偏好，服务端不从历史 Turn 继承。

该指令是 Harness 规划输入，不是必调约束。例如用户选择 HR 后发送“你好”，Harness 可以 0 次 AgentCall 直接回答；询问年假余额时才计划 `agent.call` action。后续改选只影响新 Turn，不修改运行中 Turn、历史 Turn 或已创建 AgentCall。
### 3.4 创建 Turn

`POST /api/v1/threads/{thread_id}/turns`

该接口原子接纳用户消息并创建 Turn；调用方不先单独 POST Message。

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | Thread id |
| Idempotency-Key | Header | string | 是 | 客户端消息重发幂等键 |
| input | Body | object | 是 | 类型化文本、附件引用或结构化输入 |
| selected_model | Body | string | 否 | 仅在 Agent 支持且员工有权选择时有效 |
| workspace_attachment_ids | Body | string[] | 否 | 已通过 Attachment API 创建且仍有效的 Thread Attachment；不接收裸位置 |
| agent_use | Body | object/null | 否 | mode 只能为 preferred 且 agent_id 必填；省略/null 不继承历史选择 |
| expected_thread_version | Body | integer | 否 | 可选的界面状态保护，不代替权限校验 |

```bash
curl -X POST 'https://snow.example.com/api/v1/threads/thr_01J.../turns' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: desktop-msg-82d7' \
  -H 'X-Desktop-Device-ID: <bound-device-id>' \
  -H 'X-Desktop-Signature: <request-signature>' \
  -H 'Content-Type: application/json' \
  -d '{
    "input":{"type":"text","text":"分析销售表并生成月报"},
    "agent_use":{"mode":"preferred","agent_id":"agt_hr"},
    "workspace_attachment_ids":["watt_01J..."]
  }'
```

```json
{
  "turn": {
    "id": "turn_01J...",
    "thread_id": "thr_01J...",
    "turn_sequence": 7,
    "trigger_type": "user_message",
    "turn_state": "accepted",
    "agent_use": {
      "mode": "preferred",
      "agent_id": "agt_hr",
      "display_name": "HR 助手"
    },
    "actual_agent_calls": {
      "count": 0,
      "active_call_id": null,
      "last_state": null,
      "calls": [],
      "selected_agent_called": false,
      "selected_but_unused": true
    }
  },
  "input_item": {
    "id": "item_user_01J...",
    "item_type": "user_message",
    "item_sequence": 25,
    "item_state": "completed"
  },
  "event_cursor": {"sequence": 48, "event_id": "evt_01J..."}
}
```

同一事务写入 user_message Item、Turn、`workspace_attachment_use`、`item.created` 和 `turn.accepted`；Attachment 必须已属于当前 Thread、仍有效且设备/权限匹配。指定 `agent_use` 时必须通过 `agent.invoke` 授权，未知、跨租户或未授权 Agent 统一返回 `ACTION_SCOPE_DENIED`，且不创建 Turn。Runtime 暂不可用不会回滚员工消息，Turn 后续进入 queued 或 failed。

### 3.5 查询 Item

`GET /api/v1/threads/{thread_id}/items`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | Thread id |
| cursor | Query | string | 否 | 不透明翻页游标 |
| limit | Query | integer | 否 | 1–200，默认 50 |
| turn_id | Query | string | 否 | 限定某 Turn |
| include_superseded | Query | boolean | 否 | 默认 false；排障时可查看旧回答 |

```bash
curl 'https://snow.example.com/api/v1/threads/thr_01J.../items?limit=50' \
  -H 'Authorization: Bearer <employee-token>'
```

```json
{
  "items": [
    {
      "id": "item_user_01J...",
      "turn_id": "turn_01J...",
      "item_sequence": 25,
      "item_type": "user_message",
      "item_state": "completed",
      "content": {"type":"text","text":"分析销售表并生成月报"},
      "created_at": "2026-07-15T01:01:00.000Z"
    },
    {
      "id": "item_agent_01J...",
      "turn_id": "turn_01J...",
      "item_sequence": 31,
      "item_type": "agent_message",
      "item_state": "completed",
      "content": {"type":"text","text":"月报已生成。"}
    }
  ],
  "next_cursor": null,
  "latest_event_cursor": {"sequence":52,"event_id":"evt_01J..."}
}
```

Item 列表与 `latest_event_cursor` 在同一一致性读点生成。Item API 返回当前查询投影，不返回 Token delta、隐藏思维链或 Credential。

### 3.6 订阅 Event

`GET /api/v1/threads/{thread_id}/events`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | Thread id |
| Last-Event-ID | Header | integer string | 否 | 上次已处理的 Thread event_sequence |
| after_sequence | Query | integer | 否 | 无 Event id 时的备用游标；不能与 Last-Event-ID 冲突 |
| include_transient | Query | boolean | 否 | 默认 true；接收当前连接的 delta/heartbeat |

```bash
curl -N 'https://snow.example.com/api/v1/threads/thr_01J.../events' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Accept: text/event-stream' \
  -H 'Last-Event-ID: 51'
```

```text
id: 52
event: item.completed
data: {"event_id":"evt_01J_new","sequence":52,"schema_version":1,"thread_id":"thr_01J...","turn_id":"turn_01J...","item_id":"item_agent_01J...","occurred_at":"2026-07-15T01:02:03.456Z","payload":{"item_type":"agent_message","content_hash":"sha256:..."}}

event: response.delta
data: {"transient":true,"thread_id":"thr_01J...","turn_id":"turn_next","transient_id":"delta_19","text_delta":"正在核对..."}
```

持久 Event 的 SSE id 就是 `sequence`，Envelope 另有 UUID `event_id`；transient 事件没有 SSE id，断线后不重放。若游标已超出保留窗口，返回 `409 EVENT_CURSOR_EXPIRED` 并携带最早可用 sequence；客户端重新读取带 `latest_event_cursor` 的 Item 快照，再从该 sequence 续订。

### 3.7 引导当前 Turn

`POST /api/v1/turns/{turn_id}/steer`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| turn_id | Path | string | 是 | 必须处于 running；waiting_user 只能解析对应 UserActionRequest |
| Idempotency-Key | Header | string | 是 | 命令幂等键 |
| pending_input_id | Body | string | 否 | 从队列接纳已有输入 |
| input | Body | object | 否 | 直接引导内容；与 pending_input_id 二选一 |
| mode | Body | string | 是 | next_safe_point、interrupt_generation |

```bash
curl -X POST 'https://snow.example.com/api/v1/turns/turn_01J.../steer' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: steer-20260715-1' \
  -H 'Content-Type: application/json' \
  -d '{"pending_input_id":"pin_01J...","mode":"interrupt_generation"}'
```

```json
{
  "turn_id": "turn_01J...",
  "turn_state": "running",
  "accepted_item_id": "item_guidance_01J...",
  "accepted_item_type": "user_guidance",
  "applies_at": "next_safe_point",
  "generation_interrupted": false,
  "command": {"id":"icmd_steer_01J...","command_state":"queued"},
  "queue_etag": "\"pending-queue-10\"",
  "event_id": "evt_steer_queued_01J..."
}
```

Steer 不创建第二个 Turn。接纳事务先创建 pending 状态的 user_guidance Item、持久 steer command 和 `turn.steer_queued`；Runtime 在安全点确认后才把 Item 标记 completed 并追加 `turn.steered`，`interrupt_generation` 是否实际中断也以 ack 为准。Runtime 拒绝或不支持时，命令和 Item 进入 failed，不伪造成功事实。若 Turn 为 waiting_user，返回 409 `TURN_REQUIRES_USER_ACTION`；若已终止，返回 409，客户端可把输入送入新 Turn。

### 3.8 中断当前 Turn

`POST /api/v1/turns/{turn_id}/interrupt`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| turn_id | Path | string | 是 | 当前 Turn |
| Idempotency-Key | Header | string | 是 | 命令幂等键 |
| reason_code | Body | string | 是 | user_stop、switch_context、admin_stop |
| preserve_pending_inputs | Body | boolean | 否 | 默认 true |

```bash
curl -X POST 'https://snow.example.com/api/v1/turns/turn_01J.../interrupt' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: stop-turn-7' \
  -H 'Content-Type: application/json' \
  -d '{"reason_code":"user_stop","preserve_pending_inputs":true}'
```

```json
{
  "turn_id": "turn_01J...",
  "turn_state": "running",
  "interrupt_state": "requested",
  "command": {"id":"icmd_cancel_01J...","command_state":"queued"},
  "already_completed_effects_preserved": true,
  "event_id": "evt_interrupt_requested_01J..."
}
```

该命令先写持久 cancel command 和 `turn.interrupt_requested`，不能提前宣称已停止。Runtime 最终确认 execution.cancelled 后，员工 user_stop/switch_context 使 Turn 进入 interrupted；管理员或平台取消使其进入 cancelled；Runtime 失联则按恢复策略进入 lost/failed。无论结果如何都不撤销已成功副作用，也不自动发送下一条 PendingInput。

### 3.9 重新生成

`POST /api/v1/turns/{turn_id}/regenerate`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| turn_id | Path | string | 是 | completed、interrupted 或 failed 的原 Turn |
| Idempotency-Key | Header | string | 是 | 命令幂等键 |
| binding_mode | Body | string | 是 | current_route、reuse_original |
| reason | Body | string | 否 | 员工补充说明，不复制原 user_message |

```bash
curl -X POST 'https://snow.example.com/api/v1/turns/turn_01J...:regenerate' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: regenerate-turn-7-2' \
  -H 'Content-Type: application/json' \
  -d '{"binding_mode":"current_route","reason":"按最新模型重新回答"}'
```

```json
{
  "turn_id": "turn_01J...",
  "turn_state": "regenerating",
  "invocation": {"id":"inv_regen_02","invocation_kind":"regenerate","replaces_invocation_id":"inv_initial"},
  "original_user_item_id": "item_user_01J...",
  "current_final_item_id": "item_old_answer",
  "event_id": "evt_regeneration_started"
}
```

旧回答在新回答成功前仍是当前结果。Regenerate 开始时写 `regeneration_base_state`、清空本轮 finished_at，把新 Invocation 写入 active/latest，原 adopted/final 不变。成功时原子写新 agent_message Item、标记旧 Item superseded，把新 Invocation 设为 adopted、清空 active/base state、更新 final_item_id/finished_at 并写 `invocation.completed + turn.completed`。失败时：若有旧 adopted/final，Turn 回到 completed、保留旧 adopted/final；若没有，恢复 base state（failed 或 interrupted）及原 error_code。两种情况都清空 active/base state、保留失败执行为 latest、更新 finished_at，并写 `invocation.failed + turn.regeneration_failed`。

### 3.10 创建 Fork

`POST /api/v1/threads/{thread_id}/forks`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | 源 Thread |
| Idempotency-Key | Header | string | 是 | 创建幂等键 |
| from_turn_id | Body | string | 是 | 分叉点 |
| title | Body | string | 否 | 新 Thread 标题 |
| workspace_mode | Body | string | 是 | reference、checkpoint_copy、none |

```bash
curl -X POST 'https://snow.example.com/api/v1/threads/thr_source/forks' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: fork-analysis-b' \
  -H 'Content-Type: application/json' \
  -d '{"from_turn_id":"turn_06","workspace_mode":"reference","title":"方案 B"}'
```

```json
{
  "thread": {"id":"thr_fork","title":"方案 B","lifecycle_state":"active"},
  "relation": {"relation_type":"fork","parent_thread_id":"thr_source","child_thread_id":"thr_fork"},
  "copied_through_turn_id": "turn_06",
  "filesystem_checkpoint_id": null
}
```

Fork 复制或引用会话内容边界，不默认复制文件系统。`checkpoint_copy` 只有 Environment 支持并且用户有权时可用。

### 3.11 附加 Workspace 资源

`POST /api/v1/threads/{thread_id}/workspace-attachments`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | Thread id |
| Idempotency-Key | Header | string | 是 | 创建幂等键 |
| X-Desktop-Device-ID / Signature | Header | string | Desktop 必填 | 本地 Binding 的设备证明 |
| workspace_binding_id | Body | string | 是 | 已验证的实际位置 Binding |
| resource_type / resource_ref | Body | string | 是 | file、directory、object 等受限引用 |
| access_mode | Body | string | 是 | read、read_write |
| expires_at | Body | string | 否 | 临时附加有效期 |

```bash
curl -X POST 'https://snow.example.com/api/v1/threads/thr_01J.../workspace-attachments' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: attach-local-sales-xlsx' \
  -H 'X-Desktop-Device-ID: <bound-device-id>' \
  -H 'X-Desktop-Signature: <request-signature>' \
  -H 'Content-Type: application/json' \
  -d '{"workspace_binding_id":"wbind_desktop_1","resource_type":"file","resource_ref":"file:a.xlsx","access_mode":"read_write"}'
```

```json
{
  "id": "watt_01J...",
  "thread_id": "thr_01J...",
  "workspace_binding_id": "wbind_desktop_1",
  "resource_type": "file",
  "display_ref": "a.xlsx",
  "access_mode": "read_write",
  "etag": "\"attachment-1\"",
  "event_id": "evt_attachment_added"
}
```

服务端校验 Binding.device_id 与签名设备；响应只返回安全展示引用。Runtime 通过短期 attachment handle 使用资源，不能把 Desktop 绝对路径交给 Cloud Runtime。

### 3.12 移除 Workspace Attachment

`DELETE /api/v1/workspace-attachments/{attachment_id}`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| attachment_id | Path | string | 是 | 当前员工拥有的 Thread Attachment |
| If-Match | Header | string | 是 | Attachment ETag |

```bash
curl -X DELETE 'https://snow.example.com/api/v1/workspace-attachments/watt_01J...' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'If-Match: "attachment-3"'
```

```json
{
  "id": "watt_01J...",
  "attachment_state": "removed",
  "event_id": "evt_attachment_removed"
}
```

移除只阻止后续 Invocation 取得新 handle，不撤销已开始 Invocation 的 ExecutionBinding，也不删除用户原文件。

### 3.13 查询 PendingInput

`GET /api/v1/threads/{thread_id}/pending-inputs`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | Thread id |

```bash
curl 'https://snow.example.com/api/v1/threads/thr_01J.../pending-inputs' \
  -H 'Authorization: Bearer <employee-token>'
```

```json
{
  "thread_id": "thr_01J...",
  "queue_etag": "\"pending-queue-8\"",
  "pending_inputs": [
    {"id":"pin_03","queue_position":"1000.0000000000","input":{"type":"text","text":"图表按地区拆分"},"etag":"\"pending-2\""}
  ]
}
```

Desktop/Web 恢复 Thread 时读取该列表；admitted 和 removed 输入不返回。

### 3.14 创建 PendingInput

`POST /api/v1/threads/{thread_id}/pending-inputs`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | 当前运行中的 Thread |
| Idempotency-Key | Header | string | 是 | 创建幂等键 |
| input | Body | object | 是 | 类型化输入 |

```bash
curl -X POST 'https://snow.example.com/api/v1/threads/thr_01J.../pending-inputs' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: pending-msg-3' \
  -H 'Content-Type: application/json' \
  -d '{"input":{"type":"text","text":"图表按地区拆分"}}'
```

```json
{
  "id": "pin_01J...",
  "thread_id": "thr_01J...",
  "input_state": "pending",
  "queue_position": "3000.0000000000",
  "input": {"type":"text","text":"图表按地区拆分"},
  "etag": "\"pending-1\"",
  "queue_etag": "\"pending-queue-9\""
}
```

创建队列输入不生成 user_message Item，也不自动中断当前 Turn。

### 3.15 编辑 PendingInput

`PATCH /api/v1/pending-inputs/{pending_input_id}`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| pending_input_id | Path | string | 是 | 队列输入 id |
| If-Match | Header | string | 是 | 当前 ETag |
| input | Body | object | 是 | 新内容；仅 pending 状态可改 |

```bash
curl -X PATCH 'https://snow.example.com/api/v1/pending-inputs/pin_01J...' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'If-Match: "pending-1"' \
  -H 'Content-Type: application/json' \
  -d '{"input":{"type":"text","text":"图表按大区拆分"}}'
```

```json
{
  "id": "pin_01J...",
  "input_state": "pending",
  "input": {"type":"text","text":"图表按大区拆分"},
  "etag": "\"pending-2\"",
  "queue_etag": "\"pending-queue-10\""
}
```

输入已经 admitted 时返回 409，不能修改已进入 Turn 的 user_message 或 user_guidance Item。

### 3.16 重排 PendingInput

`POST /api/v1/threads/{thread_id}/pending-inputs/reorder`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | Thread id |
| Idempotency-Key | Header | string | 是 | 重排幂等键 |
| If-Match | Header | string | 是 | GET 返回的 queue_etag |
| ordered_ids | Body | string[] | 是 | 当前所有 pending id 的完整顺序 |

```bash
curl -X POST 'https://snow.example.com/api/v1/threads/thr_01J.../pending-inputs/reorder' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: reorder-pending-4' \
  -H 'If-Match: "pending-queue-8"' \
  -H 'Content-Type: application/json' \
  -d '{"ordered_ids":["pin_03","pin_01","pin_02"]}'
```

```json
{
  "thread_id": "thr_01J...",
  "pending_inputs": [
    {"id":"pin_03","queue_position":"1000.0000000000"},
    {"id":"pin_01","queue_position":"2000.0000000000"},
    {"id":"pin_02","queue_position":"3000.0000000000"}
  ],
  "queue_etag": "\"pending-queue-9\""
}
```

列表不完整、包含非 pending 输入或并发状态改变时返回 409，客户端重新拉取队列。

### 3.17 删除 PendingInput

`DELETE /api/v1/pending-inputs/{pending_input_id}`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| pending_input_id | Path | string | 是 | 队列输入 id |
| If-Match | Header | string | 是 | 当前 ETag |

```bash
curl -X DELETE 'https://snow.example.com/api/v1/pending-inputs/pin_01J...' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'If-Match: "pending-2"'
```

```json
{
  "id": "pin_01J...",
  "input_state": "removed",
  "removed_at": "2026-07-15T01:02:30.000Z",
  "queue_etag": "\"pending-queue-11\""
}
```

删除表示从队列移除，不生成 user_message Item。已 admitted 的输入返回 409。

### 3.18 解析用户操作请求

`POST /api/v1/user-action-requests/{request_id}/resolve`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| request_id | Path | string | 是 | confirmation/auth/grant/input 请求 |
| Idempotency-Key | Header | string | 是 | 解析幂等键 |
| resolution | Body | string | 是 | confirmation/grant 为 approve、deny；input 为 submit、cancel；auth 这里只接受 cancel |
| response | Body | object | 否 | 按请求 input_schema 校验；必须脱敏 |
| grant_scope | Body | object | 否 | 仅授权请求且不得超过平台允许范围 |

```bash
curl -X POST 'https://snow.example.com/api/v1/user-action-requests/uar_01J...:resolve' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: approve-refund-preview-1' \
  -H 'Content-Type: application/json' \
  -d '{"resolution":"approve"}'
```

```json
{
  "request_id": "uar_01J...",
  "request_state": "resolved",
  "resolution": "approve",
  "turn": {"id":"turn_01J...","turn_state":"waiting_user"},
  "resume": {"command_id":"icmd_01J...","command_state":"queued"},
  "event_id": "evt_action_resolved_01J..."
}
```

请求只能解析一次。confirmation 仅接受 approve/deny，grant 仅接受 approve/deny 且 Scope 不得扩大，input 仅接受 submit/cancel 并按 input_schema 校验；auth 成功只能来自下述受信回调，本接口不能由客户端自报 completed。解析事务同时写入持久 resume command；Runtime 确认后才追加 `turn.resumed / invocation.resumed` 并进入 running。`block` 的 PermissionDecision 不创建可绕过的 approve 请求。

### 3.19 完成 Auth 回调

`GET /api/v1/user-action-requests/{request_id}/auth/callback`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| request_id | Path | string | 是 | request_type=auth 的 pending 请求 |
| code | Query | string | 是 | Provider 一次性授权码；不写 Event/Trace |
| state | Query | string | 是 | 与 auth_state_hash 比对的一次性随机值 |
| employee_session | Cookie | string | 是 | SnowHarness HttpOnly Session；与 state 共同绑定发起授权的员工 |

```bash
curl 'https://snow.example.com/api/v1/user-action-requests/uar_auth_01J.../auth/callback?code=<one-time-code>&state=<one-time-state>' \
  -H 'Cookie: <employee-session>'
```

```json
{
  "request_id": "uar_auth_01J...",
  "request_state": "resolved",
  "auth_state": "connected",
  "resume": {"command_id":"icmd_resume_01J...","command_state":"queued"}
}
```

Connection Adapter 在服务端交换 code、校验 state 和 OIDC nonce、把 Credential 写入 Vault，并在同一事务一次性消费 state/nonce、解析请求和创建 resume command。响应、Item、Event 与 Trace 只保留 connection/credential reference 和 Scope，不返回 code、Token 或 nonce。

## 4. Runtime Protocol

Runtime Protocol 是 SnowHarness 与 Agent 执行器之间的协议，不是员工 API。外部 Runtime 可以保留自己的 session/run 对象，由 Adapter 映射为 SnowHarness Invocation 与 Event。

### 4.1 启动 Invocation

`POST {runtime_endpoint}/runtime/v1/invocations`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Authorization | Header | string | 是 | 短期 Workload Token |
| Idempotency-Key | Header | string | 是 | 调度幂等键：初始为 invocation_id:initial，重试为 invocation_id:attempt_no |
| invocation_id | Body | string | 是 | 平台关联 id |
| turn_context / job_context | Body | object | 二选一 | Thread/Turn 或 Job 归属 |
| agent | Body | object | 是 | AgentRevision 制品与入口引用 |
| input_items | Body | array | 是 | 当前输入，不含无关全历史 |
| context_handle | Body | string | 是 | 按需读取上下文的短期句柄 |
| gateway_endpoints | Body | object | 是 | Tool/Artifact/UserAction 回调地址 |
| execution_limits | Body | object | 是 | 时长、Token、并发与预算 |
| workspace | Body | object | 否 | 受限 WorkspaceBinding、Attachment handle 和 access mode，不传裸跨设备路径 |
| trace_context | Body | object | 是 | W3C Trace Context |
| attempt | Body | object | 否 | 仅基础设施重调度时传 attempt_id、attempt_no、retry_reason、checkpoint_ref、新 lease handle 和 producer_sequence_start |

```bash
curl -X POST 'https://runtime.example.net/runtime/v1/invocations' \
  -H 'Authorization: Bearer <workload-token>' \
  -H 'Idempotency-Key: inv_01J:initial' \
  -H 'Content-Type: application/json' \
  -d '{
    "invocation_id":"inv_01J...",
    "turn_context":{"turn_id":"turn_01J...","thread_id":"thr_01J..."},
    "agent":{"revision_id":"agr_18","agent_artifact_ref":"oci://registry.example/finance@sha256:...","entrypoint":"agent:root","interface_requirements":{"required":["event_stream","dynamic_tools"],"optional":["steer"]}},
    "input_items":[{"id":"item_user_01J...","type":"user_message","content":{"text":"生成月报"}}],
    "context_handle":"ctxh_short_lived",
    "gateway_endpoints":{"base_url":"https://snow.example.com/gateway/v1"},
    "workspace":{"default_binding_handle":"wbh_short_lived","attachment_handles":["wah_a_xlsx"]},
    "execution_limits":{"timeout_seconds":1800,"max_tokens":120000,"cost_limit":"20.00 CNY"},
    "trace_context":{"traceparent":"00-...-...-01"}
  }'
```

```json
{
  "invocation_id": "inv_01J...",
  "accepted": true,
  "attempt_no": null,
  "runtime_session_ref": "veadk-thread-finance-42",
  "runtime_execution_ref": "veadk-session-7d2",
  "capabilities": ["event_stream","cancel","resume","steer","dynamic_tools","user_action"]
}
```

平台把 runtime_session_ref 持久化为 RuntimeSessionBinding。初始调度把 runtime_execution_ref 写入 Invocation；请求包含 attempt 时写入对应 InvocationAttempt，不能覆盖初始句柄。Runtime 只能使用给定的短期句柄和 Gateway，请求中不含数据库连接或 Credential 原值。

### 4.2 回传 Runtime Event

`POST /runtime/v1/invocations/{invocation_id}/events/batch`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| invocation_id | Path | string | 是 | Token 必须绑定该 Invocation |
| Idempotency-Key | Header | string | 是 | 批次幂等键 |
| producer_sequence_start | Body | integer | 是 | Runtime 侧连续序号起点 |
| events | Body | array | 是 | 1–100 个规范候选事件 |

```bash
curl -X POST 'https://snow.example.com/runtime/v1/invocations/inv_01J.../events:batch' \
  -H 'Authorization: Bearer <workload-token>' \
  -H 'Idempotency-Key: inv_01J-batch-4' \
  -H 'Content-Type: application/json' \
  -d '{
    "producer_sequence_start":17,
    "events":[
      {"producer_event_id":"vevt_17","type":"progress.snapshot","schema_version":1,"occurred_at":"2026-07-15T01:02:00Z","payload":{"progress_key":"main","text":"正在核对数据"}},
      {"producer_event_id":"vevt_18","type":"response.completed","schema_version":1,"occurred_at":"2026-07-15T01:02:03Z","payload":{"content":{"type":"text","text":"月报已生成"}}},
      {"producer_event_id":"vevt_19","type":"execution.completed","schema_version":1,"occurred_at":"2026-07-15T01:02:04Z","payload":{"outcome":"success"}}
    ]
  }'
```

```json
{
  "invocation_id": "inv_01J...",
  "accepted_through_producer_sequence": 19,
  "mapped_events": [
    {"producer_event_id":"vevt_17","thread_event_id":"evt_51","thread_sequence":51},
    {"producer_event_id":"vevt_18","thread_event_id":"evt_52","thread_sequence":52,"item_id":"item_agent_01J..."},
    {"producer_event_id":"vevt_19","thread_event_id":"evt_53","thread_sequence":53}
  ]
}
```

Ingress 先以 `(invocation_id, producer_event_id)` 和 `(invocation_id, producer_sequence)` 写入幂等账本，再校验类型、身份、大小和脱敏规则，由平台事务创建 Item/ThreadEvent 或更新 Job/JobEvent。重新分批或部分重放返回原映射；Runtime 不能指定 Thread/Job event sequence、Item id 或直接更新 Item。可修复的 Schema/大小错误不消费 producer sequence；身份、租户和 hash 冲突等不可修复错误原子终止 Invocation。基础设施重调度时平台把下一连续序号传为 `attempt.producer_sequence_start`，Runtime 不能按 Attempt 从 1 重启。

#### Runtime Candidate Event 映射

| Candidate type | 平台状态写入 | 公开 Event |
|---|---|---|
| progress.snapshot | Turn Invocation 按 invocation + progress_key 创建/更新 public_progress Item；Job Invocation 更新 Job 进度投影 | item.created/item.updated，或 job.progress_updated |
| response.completed | Turn Invocation 创建 agent_message Item；Regenerate 成功时切 final_item 并 supersede 旧回答。Job Invocation 写 result_ref/Artifact 引用，不创建 Item | item.completed、可选 item.superseded，或 job.result_recorded |
| user_action.requested | 仅 Turn Invocation 可创建员工 UserActionRequest 及其 Item；纯 Job 收到该 Candidate 时拒绝，必须在调度前准备授权，或使用已登记 external callback 进入 waiting_external | user_action.requested、turn.waiting |
| execution.completed | Invocation 完成；Thread Turn 随之完成，Job 先更新单次执行 | invocation.completed + turn.completed，或 job.invocation_completed；仅 Job 完成条件满足时另写 job.completed |
| execution.failed | Invocation 失败并保存稳定错误码 | invocation.failed + turn.failed，或 job.invocation_failed；仅失败策略终止整个 Job 时另写 job.failed |
| execution.cancelled | Invocation 确认取消并保留已完成副作用 | invocation.cancelled + turn.interrupted（员工停止）或 turn.cancelled（管理员/平台取消）；Job 先写 job.invocation_cancelled，仅 Job 整体取消时写 job.cancelled |

`response.delta`、heartbeat 和 stdout/stderr 不进入该批次账本，走 transient 通道或 Trace；纯 Job 的临时输出只发给后台订阅者。Tool 意图必须调用 Gateway ToolCall API，不能用候选 Event 绕过 Schema、Policy 和 operation_id。

### 4.3 回传 Transient Event

`POST /runtime/v1/invocations/{invocation_id}/transient-events/batch`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| invocation_id | Path | string | 是 | 当前运行 Invocation |
| Idempotency-Key | Header | string | 是 | 当前连接内 transient 批次重放键；不把事件变成持久 Event |
| transient_sequence_start | Body | integer | 是 | 仅当前 Runtime connection 内递增 |
| events | Body | array | 是 | response.delta、heartbeat、tool.log；1–100 条 |

```bash
curl -X POST 'https://snow.example.com/runtime/v1/invocations/inv_01J.../transient-events:batch' \
  -H 'Authorization: Bearer <workload-token>' \
  -H 'Idempotency-Key: inv-01J-transient-41' \
  -H 'Content-Type: application/json' \
  -d '{"transient_sequence_start":41,"events":[{"transient_id":"td_41","type":"response.delta","payload":{"text_delta":"正在核对"}}]}'
```

```json
{
  "invocation_id": "inv_01J...",
  "accepted_through_transient_sequence": 41,
  "persisted": false
}
```

平台只向当前订阅者转发并按诊断策略采样到 Trace；断线不重放。Runtime 最终必须发送 execution.completed、execution.failed 或 execution.cancelled；有正式文本结果时，在终态前另发 response.completed。

### 4.4 取消 Invocation

`POST {runtime_endpoint}/runtime/v1/invocations/{invocation_id}/cancel`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| invocation_id | Path | string | 是 | 执行 id |
| Idempotency-Key | Header | string | 是 | 取消幂等键 |
| reason_code | Body | string | 是 | user_interrupt、timeout、policy_block、admin_stop |
| deadline | Body | string | 是 | Runtime 最晚停止时间 |

```bash
curl -X POST 'https://runtime.example.net/runtime/v1/invocations/inv_01J...:cancel' \
  -H 'Authorization: Bearer <workload-token>' \
  -H 'Idempotency-Key: cancel-inv-01J' \
  -H 'Content-Type: application/json' \
  -d '{"reason_code":"user_interrupt","deadline":"2026-07-15T01:03:10Z"}'
```

```json
{
  "invocation_id": "inv_01J...",
  "cancel_state": "accepted",
  "already_completed_effects_preserved": true
}
```

Runtime 应停止新行动并报告最终状态；无法立即停止时返回 accepted，平台继续以 Event/heartbeat 判定 lost 或 cancelled。

### 4.5 恢复 Invocation

`POST {runtime_endpoint}/runtime/v1/invocations/{invocation_id}/resume`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| invocation_id | Path | string | 是 | waiting_user 的原 Invocation |
| Idempotency-Key | Header | string | 是 | invocation_command id |
| runtime_execution_ref | Body | string | 是 | 原 Runtime 执行句柄 |
| resolution_ref | Body | string | 是 | 已解析 UserActionRequest 的短期引用 |
| checkpoint_ref | Body | string | 否 | Runtime 已丢失内存状态时的受控恢复点 |

```bash
curl -X POST 'https://runtime.example.net/runtime/v1/invocations/inv_01J...:resume' \
  -H 'Authorization: Bearer <workload-token>' \
  -H 'Idempotency-Key: icmd_01J...' \
  -H 'Content-Type: application/json' \
  -d '{"runtime_execution_ref":"veadk-session-7d2","resolution_ref":"uar-resolution-short-lived"}'
```

```json
{
  "invocation_id": "inv_01J...",
  "resume_state": "accepted",
  "runtime_execution_ref": "veadk-session-7d2",
  "requires_redispatch": false
}
```

若原 Runtime execution 已丢失，返回 `requires_redispatch=true`；平台为同一 Invocation 创建 Attempt 和新 EnvironmentLease，从安全 Checkpoint 重调度，不能新建 continuation Invocation 或更换 ExecutionBinding。

### 4.6 引导 Invocation

`POST {runtime_endpoint}/runtime/v1/invocations/{invocation_id}/steer`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| invocation_id | Path | string | 是 | 当前 running Invocation |
| Idempotency-Key | Header | string | 是 | invocation_command id |
| runtime_execution_ref | Body | string | 是 | 当前 Runtime 执行句柄 |
| guidance_item_ref | Body | string | 是 | 平台已落库的短期 user_guidance 引用 |
| mode | Body | string | 是 | next_safe_point、interrupt_generation |

```bash
curl -X POST 'https://runtime.example.net/runtime/v1/invocations/inv_01J...:steer' \
  -H 'Authorization: Bearer <workload-token>' \
  -H 'Idempotency-Key: icmd_steer_01J...' \
  -H 'Content-Type: application/json' \
  -d '{"runtime_execution_ref":"veadk-session-7d2","guidance_item_ref":"guidance-short-lived","mode":"interrupt_generation"}'
```

```json
{
  "invocation_id": "inv_01J...",
  "steer_state": "accepted",
  "applies_at": "next_safe_point",
  "generation_interrupted": true
}
```

只有该 ack 成功后，平台才完成 user_guidance Item 并写 `turn.steered`。waiting_user Invocation 不接受 steer；Runtime 不支持或拒绝时返回明确错误，平台把 command/Item 标记 failed，不把队列输入伪装成已应用。

### 4.7 Runtime 能力发现

`GET {runtime_endpoint}/runtime/v1/capabilities`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Authorization | Header | string | 是 | Runtime 探测身份 |
| protocol_version | Query | string | 是 | 平台支持的协议版本 |

```bash
curl 'https://runtime.example.net/runtime/v1/capabilities?protocol_version=1' \
  -H 'Authorization: Bearer <runtime-probe-token>'
```

```json
{
  "protocol_versions": ["1"],
  "features": {
    "event_stream": true,
    "cancel": true,
    "resume": true,
    "steer": true,
    "dynamic_tools": true,
    "user_action": true,
    "workspace_types": ["cloud","remote"],
    "filesystem_checkpoint": false
  },
  "limits": {"max_invocation_seconds":86400,"max_event_bytes":262144}
}
```

管理员界面根据实际能力禁用不支持的选项；不允许手工勾选 Runtime 并未声明的能力。

## 5. Gateway API

### 5.1 执行 ToolCall

`POST /gateway/v1/tool-calls`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Authorization | Header | string | 是 | Invocation-scoped Token |
| Idempotency-Key | Header | string | 是 | 推荐等于 operation_id |
| invocation_id | Body | string | 是 | 必须与 Token 一致 |
| tool_id | Body | string | 是 | 已发现并允许的 Tool |
| schema_hash | Body | string | 是 | 模型看到的 Schema |
| operation_id | Body | string | 是 | 稳定副作用幂等 id |
| arguments | Body | object | 是 | 只含业务参数；无 user/tenant/credential |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/tool-calls' \
  -H 'Authorization: Bearer <invocation-token>' \
  -H 'Idempotency-Key: op-report-query-7' \
  -H 'Content-Type: application/json' \
  -d '{"invocation_id":"inv_01J...","tool_id":"tool_erp_query","schema_hash":"sha256:abc...","operation_id":"op-report-query-7","arguments":{"month":"2026-06"}}'
```

```json
{
  "tool_call_id": "tc_01J...",
  "call_state": "succeeded",
  "result": {"type":"artifact_ref","artifact_id":"art_01J..."},
  "effect": null,
  "schema_revision_id": "tsr_42"
}
```

Gateway 重新取得当前 Schema 并核对 hash；不一致返回 409 `TOOL_SCHEMA_CHANGED` 和新 Schema 摘要，让 Agent 重新封装参数。同一 Tool + operation_id 若 arguments_hash 不同，返回 409 `OPERATION_PAYLOAD_CONFLICT`。平台在服务端注入身份、Connection 和 Credential。ToolCall 以 Invocation 为根：Turn Invocation 写 ThreadEvent，Job Invocation 写 JobEvent，不要求伪造 thread_id、turn_id 或 Item。

### 5.2 核对 Tool Effect

`POST /gateway/v1/tool-calls/{tool_call_id}/reconcile-effect`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| tool_call_id | Path | string | 是 | unknown_effect 或待核对 ToolCall |
| Idempotency-Key | Header | string | 是 | 核对命令幂等键 |
| operation_id | Body | string | 是 | 必须与原 ToolCall 一致 |
| verification_mode | Body | string | 是 | 仅 provider_query |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/tool-calls/tc_01J...:reconcile-effect' \
  -H 'Authorization: Bearer <invocation-token>' \
  -H 'Idempotency-Key: reconcile-op-report-send-7' \
  -H 'Content-Type: application/json' \
  -d '{"operation_id":"op-report-send-7","verification_mode":"provider_query"}'
```

```json
{
  "tool_call_id": "tc_01J...",
  "effect_state": "confirmed_partial",
  "targets": {"total":86,"confirmed_success":84,"confirmed_failure":2,"unknown":0},
  "event_ref": {"stream_type":"thread","event_id":"evt_effect_reconciled"}
}
```

该 Gateway 接口只允许仍有效的 Invocation Workload Token 做即时 provider query，不接受人工证据。核对只读取目标系统，不重放原副作用；存在 unknown target 时总状态仍为 unknown_effect。Invocation 已终止、Token 已过期或需人工证据时必须使用 Admin verifier 接口。

### 5.3 创建 Artifact

`POST /gateway/v1/artifacts`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | Artifact 创建幂等键 |
| invocation_id | Form | string | 是 | Workload Token 绑定的 Invocation |
| display_name | Form | string | 是 | 员工可见文件名 |
| media_type | Form | string | 是 | MIME type |
| content_hash | Form | string | 是 | 上传前计算的 hash |
| file | Form | binary | 是 | Artifact 内容；大小受 Runtime/租户限制 |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/artifacts' \
  -H 'Authorization: Bearer <invocation-token>' \
  -H 'Idempotency-Key: artifact-monthly-report-v1' \
  -F 'invocation_id=inv_01J...' \
  -F 'display_name=月报.xlsx' \
  -F 'media_type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' \
  -F 'content_hash=sha256:abc...' \
  -F 'file=@report.xlsx'
```

```json
{
  "artifact_id": "art_01J...",
  "content_hash": "sha256:abc...",
  "byte_size": 48231,
  "event_ref": {"stream_type":"thread","event_id":"evt_artifact_created"}
}
```

Artifact 内容进入对象存储；Turn Invocation 可创建 Artifact Item 并追加 ThreadEvent，Job Invocation 只记录 Artifact 与 JobEvent。显式发布到某个 Turn 时新建 job_result_projection 和 job_result Item，不改挂 Job Artifact。响应中的 `event_ref.stream_type` 为 thread 或 job。Desktop 原地修改的用户文件不强制上传为 Artifact，改用 FileChange + WorkspaceBinding 引用。

### 5.4 查询上下文

`POST /gateway/v1/context/query`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Authorization | Header | string | 是 | Invocation-scoped Token |
| context_handle | Body | string | 是 | 启动时发放的短期句柄 |
| sources | Body | array | 是 | recent_items、memory、knowledge、workspace_map、skill |
| query | Body | string | 是 | 当前缺口描述 |
| limits | Body | object | 是 | 每类条数、Token 和敏感级别限制 |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/context/query' \
  -H 'Authorization: Bearer <invocation-token>' \
  -H 'Content-Type: application/json' \
  -d '{"context_handle":"ctxh_short_lived","sources":["knowledge","memory"],"query":"月报口径和员工币种偏好","limits":{"max_items":8,"max_tokens":4000}}'
```

```json
{
  "results": [
    {"source_type":"knowledge_document","source_id":"kdoc_7","revision_id":"kdr_12","content_hash":"sha256:...","content":"...","citation_ref":"kb://finance/monthly-report#12"},
    {"source_type":"memory","source_id":"mem_9","content_hash":"sha256:...","content":"默认使用人民币","scope":"user_preference"}
  ],
  "capability_use_recorded": true
}
```

查询结果受当前用户、Agent、Workspace、Policy 和数据分类共同限制；Runtime 不能枚举另一个 Invocation 的 Context。

### 5.5 发起用户操作请求

`POST /gateway/v1/user-action-requests`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | 用户操作请求幂等键 |
| invocation_id | Body | string | 是 | 必须是 Turn Invocation；纯 Job 不接受员工 UserAction |
| tool_call_id | Body | string | 否 | 请求由 ToolCall 引起时填写，且必须属于该 Invocation |
| request_type | Body | string | 是 | confirmation、auth、grant、input |
| prompt | Body | object | 是 | 员工可理解的原因和影响 |
| input_schema | Body | object | 否 | input 类型必填 |
| expires_at | Body | string | 否 | 过期时间 |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/user-action-requests' \
  -H 'Authorization: Bearer <invocation-token>' \
  -H 'Idempotency-Key: confirm-batch-send-1' \
  -H 'Content-Type: application/json' \
  -d '{"invocation_id":"inv_01J...","tool_call_id":"tc_01J...","request_type":"confirmation","prompt":{"title":"确认群发月报","impact":"将向 86 名员工发送邮件"}}'
```

```json
{
  "request_id": "uar_01J...",
  "request_state": "pending",
  "turn_state": "waiting_user",
  "event_id": "evt_uar_01J..."
}
```

Runtime 收到 pending 后暂停相关行动，不能在本地自造确认结果。纯 Job 调用返回 409 `JOB_USER_ACTION_NOT_ALLOWED`；它必须在调度前具备授权，或使用已登记 external callback 进入 waiting_external。

## 6. Admin Control API

常规列表和详情遵守公共分页、ETag 和审计规则。下列接口定义发布与路由的关键边界。

| 管理资源族 | API 根路径 | 写入边界 |
|---|---|---|
| Agent | `/admin/api/v1/agents`、`/agent-revisions` | 稳定身份与不可变修订分开；发布后修订只读 |
| Runtime | `/admin/api/v1/runtimes`、`/runtime-revisions` | 能力探测结果写 RuntimeRevision；Endpoint 只引用 Connection |
| 路由 | `/admin/api/v1/deployment-routes` | 只影响新 Invocation，更新使用 ETag |
| Skill | `/admin/api/v1/skills`、`/skill-versions` | 稳定身份与内容版本分开，不触发 AgentRevision |
| Tool | `/admin/api/v1/tool-providers`、`/tools`、`/tool-schema-revisions` | Schema 和风险差异单独审核 |
| Knowledge | `/admin/api/v1/knowledge-bases`、`/knowledge-documents` | 文档修订与索引状态分开 |
| Connection/Credential | `/admin/api/v1/connections`、`/credential-refs` | Credential API 只接收 Vault 写入会话，读响应不返回原值 |
| Policy | `/admin/api/v1/policy-sets`、`/policy-revisions` | 规则发布后不可改，绑定切换写 AuditEvent |
| Evaluation | `/admin/api/v1/evaluation-runs`、`/evaluation-results` | 使用测试环境，不修改线上 Invocation |
| Job | `/admin/api/v1/jobs`、`/jobs/{id}/events` | 后台任务和 JobEvent；结果进入会话必须显式发布 |
| Observability | `/admin/api/v1/threads`、`/turns`、`/invocations`、`/traces` | 只读投影；内容级别受 RBAC 和采集策略限制 |

统一目录使用 `/admin/api/v1/catalog` 查询上述资源，但没有通用 Catalog 写接口；修改动作必须回到对应资源族。

### 6.1 创建 AgentRevision

`POST /admin/api/v1/agents/{agent_id}/revisions`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| agent_id | Path | string | 是 | 稳定 Agent |
| Idempotency-Key | Header | string | 是 | CI/CD 构建幂等键 |
| source | Body | object | 是 | Git commit、artifact、entrypoint |
| artifact_digest | Body | string | 是 | 可执行 Agent 制品内容 digest，不接受可变 tag 作为历史依据 |
| instruction_hash | Body | string | 是 | 指令 hash |
| model_policy | Body | object | 是 | 默认模型策略 |
| permission_requirements | Body | object | 是 | 权限要求 |
| delegation_policy | Body | object | 是 | 委派范围 |
| agent_interface_requirements | Body | object | 是 | required 与 optional 分开；不是 Runtime 实际能力 |
| agent_contract_snapshot_id | Body | string | 是 | 绑定的不可变 AgentContractSnapshot id（发布权威外部合同；必须属于同租户同 Agent） |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/agents/agt_finance/revisions' \
  -H 'Authorization: Bearer <cicd-service-token>' \
  -H 'Idempotency-Key: build-7f3a9c2' \
  -H 'Content-Type: application/json' \
  -d '{
    "source":{"type":"veadk","git_commit":"7f3a9c2","agent_artifact_ref":"oci://registry.example/finance@sha256:...","entrypoint":"agent:root"},
    "artifact_digest":"sha256:agent-artifact...",
    "instruction_hash":"sha256:...",
    "model_policy":{"default":"doubao-pro"},
    "permission_requirements":{"tool_risk_max":"high_with_confirmation"},
    "delegation_policy":{"allowed_agent_ids":["agt_chart"]},
    "agent_interface_requirements":{"required":["event_stream","dynamic_tools"],"optional":["steer"]},
    "agent_contract_snapshot_id":"acs_7f9c1"
  }'
```

```json
{
  "id": "agr_19",
  "agent_id": "agt_finance",
  "revision_no": 19,
  "revision_state": "draft",
  "source_revision": "7f3a9c2",
  "etag": "\"agent-revision-19\""
}
```

Skill、Tool 和 Knowledge 不作为 AgentRevision 的固定内容清单提交。

### 6.2 发布 AgentRevision

`POST /admin/api/v1/agent-revisions/{revision_id}/publish`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| revision_id | Path | string | 是 | draft 修订 |
| Idempotency-Key | Header | string | 是 | 发布幂等键 |
| If-Match | Header | string | 是 | Revision ETag |
| release_notes | Body | string | 是 | 发布说明 |
| evidence_refs | Body | array | 否 | CI、评测和安全审核引用 |
| artifact_attestation_id | Body | string | 否 | 可选供应链证明；发布权威是绑定的 AgentContractSnapshot |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/agent-revisions/agr_19:publish' \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Idempotency-Key: publish-agr-19' \
  -H 'If-Match: "agent-revision-19"' \
  -H 'Content-Type: application/json' \
  -d '{"release_notes":"修正月报校验规则","evidence_refs":["evalrun_88","ci_551"],"artifact_attestation_id":"att_agent_19"}'
```

```json
{
  "id": "agr_19",
  "revision_state": "published",
  "published_at": "2026-07-15T02:00:00.000Z",
  "audit_event_id": "audit_01J..."
}
```

发布只使 Revision 可路由；是否承接流量由 DeploymentRoute 决定。服务端独立校验 attestation 的 digest、签名、SBOM、provenance 和验证策略，不信任调用方自报结果；失败返回 `ARTIFACT_ATTESTATION_FAILED`。

### 6.3 更新 DeploymentRoute

`PUT /admin/api/v1/deployment-routes/{route_id}`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| route_id | Path | string | 是 | 路由 id |
| If-Match | Header | string | 是 | 所属 RouteSet ETag；服务端锁定整组路由 |
| route_set_id | Body | string | 是 | 同 Scope 路由集合 |
| agent_revision_id | Body | string | 是 | 已发布 AgentRevision |
| runtime_revision_id | Body | string | 是 | 已发布 RuntimeRevision |
| traffic_weight | Body | integer | 是 | 0–10000 基点 |
| priority_no | Body | integer | 是 | 冲突时优先级 |
| route_state | Body | string | 是 | enabled、disabled |

```bash
curl -X PUT 'https://snow.example.com/admin/api/v1/deployment-routes/route_finance_default' \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'If-Match: "route-set-12"' \
  -H 'Content-Type: application/json' \
  -d '{"route_set_id":"routeset_finance_prod","agent_revision_id":"agr_19","runtime_revision_id":"rtr_7","traffic_weight":1000,"priority_no":100,"route_state":"enabled"}'
```

```json
{
  "id": "route_finance_default",
  "route_set_id": "routeset_finance_prod",
  "agent_revision_id": "agr_19",
  "runtime_revision_id": "rtr_7",
  "traffic_weight": 1000,
  "route_set_version_no": 13,
  "etag": "\"route-set-13\"",
  "affects_new_invocations_only": true
}
```

Scope 只由 RouteSet 管理，单条 Route 不能覆盖。服务端锁定 RouteSet 后校验同 Scope 总权重、网络区和策略兼容性，并要求 AgentRevision 的 required interface requirements 是 RuntimeRevision capabilities 的子集；optional 能力缺失只禁用对应功能。AgentRevision 与 RuntimeRevision 的当前 digest 必须都有 verified attestation，RuntimeRevision 的基础一致性用例必须通过，否则返回 `ARTIFACT_NOT_VERIFIED` 并保持 RouteSet 版本不变。Route 更新不修改进行中的 ExecutionBinding。

### 6.4 查询实际执行记录

`GET /admin/api/v1/invocations/{invocation_id}/actual-execution-record`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| invocation_id | Path | string | 是 | Invocation id |
| include | Query | string[] | 否 | capabilities、tools、permissions、trace_summary；受 RBAC 限制 |

```bash
curl 'https://snow.example.com/admin/api/v1/invocations/inv_01J.../actual-execution-record?include=capabilities,tools,permissions,trace_summary' \
  -H 'Authorization: Bearer <admin-token>'
```

```json
{
  "invocation_id": "inv_01J...",
  "turn_id": "turn_01J...",
  "job_id": null,
  "execution_state": "completed",
  "output_item_id": "item_agent_01J...",
  "binding": {
    "agent_revision_id":"agr_19",
    "runtime_revision_id":"rtr_7",
    "deployment_route_id":"route_finance_default",
    "model":{"provider":"volcengine","id":"doubao-pro"},
    "initial_environment_lease_id":"envl_01J...",
    "policy_revision_id":"polr_31"
  },
  "capabilities": [
    {"type":"skill","id":"sk_monthly_report","revision_id":"skv_15","content_hash":"sha256:..."}
  ],
  "tools": [
    {"tool_call_id":"tc_01J...","tool_id":"tool_erp_query","schema_hash":"sha256:...","effect_state":null,"call_state":"succeeded"}
  ],
  "permissions": [{"decision":"allow","policy_revision_id":"polr_31"}],
  "attempts": [],
  "event_summary": {
    "stream_type": "thread",
    "first_sequence": 48,
    "last_sequence": 52,
    "terminal_event_id": "evt_invocation_completed"
  },
  "trace_summary": {"duration_ms":18321,"prompt_tokens":12450,"completion_tokens":2190,"cost":{"amount":"0.83","currency":"CNY"}}
}
```

该接口是读模型，不允许 PATCH，也不返回 Credential、未脱敏输入或隐藏思维链。

### 6.5 管理核对长期未知副作用

`POST /admin/api/v1/tool-calls/{tool_call_id}/reconcile-effect`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| tool_call_id | Path | string | 是 | unknown_effect ToolCall |
| Idempotency-Key | Header | string | 是 | 管理命令幂等键 |
| verification_mode | Body | string | 是 | provider_query、callback_evidence、manual_evidence |
| evidence_ref | Body | string | 条件必填 | callback/manual 模式的受控证据引用 |
| reason | Body | string | 是 | 审计原因 |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/tool-calls/tc_01J...:reconcile-effect' \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Idempotency-Key: admin-reconcile-op-7' \
  -H 'Content-Type: application/json' \
  -d '{"verification_mode":"manual_evidence","evidence_ref":"evidence://effect/approved-7","reason":"业务负责人已核对目标系统回执"}'
```

```json
{
  "tool_call_id": "tc_01J...",
  "effect_state": "confirmed_partial",
  "call_state": "succeeded",
  "audit_event_id": "audit_effect_reconciled_01J...",
  "event_ref": {"stream_type":"job","event_id":"jevt_effect_reconciled"}
}
```

该命令使用管理员 RBAC 或内部 verifier 身份，不复用过期 Workload Token。Effect 与 ToolCall 在同一事务更新：confirmed_success/partial → succeeded，confirmed_failure → failed，仍有未知目标则保持 unknown_effect；同时追加 ThreadEvent 或 JobEvent 和不可修改 AuditEvent。

### 6.6 订阅 JobEvent

`GET /admin/api/v1/jobs/{job_id}/events`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| job_id | Path | string | 是 | Job id |
| Last-Event-ID | Header | integer string | 否 | 上次已处理的 Job event_sequence |
| after_sequence | Query | integer | 否 | 无 Last-Event-ID 时的备用游标 |

```bash
curl -N 'https://snow.example.com/admin/api/v1/jobs/job_eval_01J.../events' \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Accept: text/event-stream' \
  -H 'Last-Event-ID: 17'
```

```text
id: 18
event: job.result_recorded
data: {"event_id":"jevt_01J...","sequence":18,"job_id":"job_eval_01J...","invocation_id":"inv_job_01J...","payload":{"result_ref":"artifact://eval/result-88"}}
```

JobEvent 与 ThreadEvent 使用相同 envelope 规则，但根 id 是 job_id、序号只在 Job 内递增，不进入员工 Thread SSE。

### 6.7 把 Job 结果发布到会话

`POST /admin/api/v1/jobs/{job_id}/publish-to-thread`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| job_id | Path | string | 是 | 已产生 result_ref 的 Job |
| Idempotency-Key | Header | string | 是 | 发布命令幂等键 |
| thread_id | Body | string | 是 | 有权接收结果的员工 Thread |
| publish_mode | Body | string | 是 | system_turn、existing_source_turn |
| source_turn_id | Body | string | 条件必填 | existing_source_turn 时必须是该 Job 的已记录来源 Turn |
| display_summary | Body | string | 是 | 员工可见的脱敏摘要 |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/jobs/job_eval_01J...:publish-to-thread' \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Idempotency-Key: publish-job-eval-88' \
  -H 'Content-Type: application/json' \
  -d '{"thread_id":"thr_01J...","publish_mode":"system_turn","display_summary":"评测已完成，结果见附件"}'
```

```json
{
  "job_id": "job_eval_01J...",
  "thread_id": "thr_01J...",
  "turn_id": "turn_system_01J...",
  "item_id": "item_job_result_01J...",
  "projection_id": "jrp_01J...",
  "event_ids": ["evt_turn_accepted","evt_item_created","evt_item_completed","evt_turn_completed","evt_job_result_published"]
}
```

system_turn 在一个事务创建 trigger_type=job_result_projection、无 Invocation 的系统触发 Turn、`job_result_projection`、invocation_id 为空的 job_result Item，并按 turn.accepted → item.created/completed → turn.completed 写事件；这是状态机唯一允许的 accepted → completed 快捷边。Turn 的 active/latest/adopted_invocation_id 都为空，final_item_id 指向该 Item。existing_source_turn 只允许在预先记录的来源 Turn 新增同类投影 Item，不改挂原 Job Artifact，也不覆盖已有 adopted/final。目标 thread_id 必须等于 Job 创建时记录的 thread_id；未预先关联 Thread 的 Job 不能事后任意发布。该命令不创建 user_message，也不允许直接在 Thread 下生成无 Turn Item。

## 7. Event 协议

### 7.1 持久 Event Envelope

```json
{
  "event_id": "evt_01J...",
  "stream_type": "thread",
  "sequence": 52,
  "event_type": "item.completed",
  "schema_version": 1,
  "thread_id": "thr_01J...",
  "turn_id": "turn_01J...",
  "item_id": "item_agent_01J...",
  "invocation_id": "inv_01J...",
  "actor": {"type":"agent","id":"agt_finance"},
  "correlation_id": "corr_01J...",
  "causation_id": "evt_previous",
  "occurred_at": "2026-07-15T01:02:03.456Z",
  "payload": {
    "item_type": "agent_message",
    "content_hash": "sha256:..."
  }
}
```

客户端只依赖公开字段和已声明的 Event type。`stream_type=thread` 时必须有 thread_id 且不能有 job_id，`stream_type=job` 反之。新增 payload 字段向后兼容；删除或改变字段语义必须提升 schema_version。完整机器定义见 [Event Envelope Schema](./contracts/event-envelope.schema.json) 和 [Event Catalog](./contracts/event-catalog.json)。

### 7.2 核心 Event 类型

| 分组 | Event | 何时持久化 |
|---|---|---|
| Thread | thread.created、thread.archived、thread.model_changed、thread.environment_changed、thread.deleted | 会话根状态和下一次执行默认设置变化 |
| Turn | turn.accepted、turn.queued、turn.started、turn.waiting、turn.resumed、turn.steer_queued、turn.steered、turn.interrupt_requested、turn.regeneration_started、turn.regeneration_failed、turn.interrupted、turn.completed、turn.failed、turn.cancelled | 正式交互状态变化 |
| Item | item.created、item.updated、item.completed、item.failed、item.superseded、item.cancelled | 可查询内容变化 |
| Pending input | pending_input.created、pending_input.updated、pending_input.reordered、pending_input.admitted、pending_input.removed | Desktop/Web 队列同步 |
| Invocation | invocation.queued、invocation.started、invocation.waiting、invocation.resumed、invocation.completed、invocation.failed、invocation.cancelled、invocation.lost | Thread 所属执行的关键边界；员工端可过滤，Job 使用 JobEvent |
| Harness action | harness.action.proposed、harness.action.started、harness.action.completed、harness.action.failed | Harness 对 model/knowledge/tool/agent/final 行动的持久编排记录；AgentCall 是其中 `agent.call` 的子执行事实 |
| Tool | tool_call.proposed、tool_call.paused、tool_call.started、tool_call.succeeded、tool_call.failed、tool_call.cancelled、tool_call.effect_confirmed、tool_call.effect_failed、tool_call.effect_unknown、tool_call.effect_reconciled | Tool 与副作用状态变化 |
| User action | user_action.requested、user_action.resolved、user_action.expired | 确认、登录、授权、输入 |
| Workspace/result | workspace.changed、workspace_attachment.added、workspace_attachment.removed、artifact.created、file.changed、job_result.published | 资源位置、产物和后台结果投影变化 |
| Collaboration | child_thread.created、child_thread.completed、child_thread.cancelled、handoff.requested、handoff.completed | 多智能体关系 |
| Governance | permission.decided、grant.issued、grant.revoked、budget.warning、policy.blocked | 安全和预算结果 |

不把不同 Runtime 的原始回调名直接暴露为 Event type。Adapter 负责映射；无法映射的诊断事件进入 Trace，而不是随意扩展员工协议。

上表是员工会话常用分组，不替代机器目录。Memory Candidate、环境变更、Job 命令以及 `job.invocation_*` 的完整持久类型以 [event-catalog.json](./contracts/event-catalog.json) 为准。

### 7.3 Transient Event

以下内容默认不持久化为 ThreadEvent：

- response.delta、reasoning summary delta。
- heartbeat、队列估算和高频 Token/日志片段。
- Tool stdout/stderr 增量。
- Runtime Adapter 内部重连细节。

它们使用 `transient=true + transient_id`，可在连接内排序；完成或异常时必须形成持久 Item 和 Event。需要诊断保留时写 Trace 对象，不改变会话事实。

### 7.4 顺序与去重

1. Runtime 使用 `producer_event_id + producer_sequence` 保证其单 Invocation 输出顺序。
2. Event Ingress 先按 `(invocation_id, producer_event_id/producer_sequence)` 去重；批次 Idempotency-Key 只负责重放批次响应，再由平台分配 Thread sequence。
3. 客户端以 Thread sequence 应用持久 Event，不按 occurred_at 排序。
4. 跨 Thread 没有全局业务顺序；管理时间线按 occurred_at 展示并标出来源。
5. Item 投影器按 Event sequence 幂等更新，checkpoint 只在事务提交后前移。

### 7.5 恢复规则

~~~text
客户端断线
→ 使用 Last-Event-ID 中的 event_sequence 续读持久 Event
→ 若游标过期，获取 Item 快照和 latest_event_cursor
→ 再订阅新的 Event
→ 当前 Invocation 的 transient delta 可丢，最终 Item 不丢
~~~

Runtime 失联时由 Invocation heartbeat 和 Attempt 状态判断；恢复执行必须读取 ExecutionBinding、已完成 ToolCall 和 EffectRecord，不能重新解析一套版本或盲目重放副作用。

## 8. 外部 Runtime Adapter

Adapter 负责把各工具的概念翻译到 SnowHarness，不要求对方改用内部表：

| 外部产品概念 | SnowHarness 映射 |
|---|---|
| Codex Thread / Turn / Item | 尽量一一映射；Codex 通知转规范 Event；fork/steer/interrupt 映射同名命令 |
| Claude Session | 映射 Thread 或 Invocation session handle；文件状态另映射 Workspace/Checkpoint，不把 session resume 当文件恢复 |
| VeADK app/user/session + Event | app 对应 Agent/Runtime 入口，user/session 对应身份与 Thread handle，Runner Event 进入 Ingress |
| Qoder session event stream | session 对应 Thread/Invocation handle，Last-Event-ID 在 Adapter 内映射到平台 sequence |
| OpenCode SessionEvent / SessionMessage | Event 映射 ThreadEvent，消息投影映射 Item；高频 delta 保持 transient |
| OpenHands Conversation / Event / Sandbox | Conversation 对应 Thread，Event 进入 Ingress，Sandbox 对应 EnvironmentLease |

Adapter 必须使用同一组规范能力名声明 `event_stream、cancel、resume、steer、dynamic_tools、user_action、workspace_types、filesystem_checkpoint` 和最大时长。AgentRevision 只声明 interface requirements，RuntimeRevision 的探测结果才是实际能力；DeploymentRoute 发布时校验两者兼容。缺少能力时员工端选项禁用并说明，不用假实现返回成功。

## 9. 安全边界

1. Runtime 和 Gateway Token 都绑定 tenant、invocation、runtime_revision、允许的 audience 和短有效期。
2. Runtime Event payload 在写入前经过大小、Schema、内容分类和脱敏校验。
3. Tool 参数由当前 Schema 校验；身份、连接和 Credential 由平台注入。
4. `allow / pause / block` 由 Policy 服务给出；Runtime 不能降级 block。
5. UserActionRequest 解析需要当前员工身份和一次性 state；登录回调不能只靠 request_id。
6. Desktop 本地路径操作同时校验设备签名、WorkspaceBinding、用户意图和环境策略。
7. Admin API 每次发布、路由、策略和 Credential 操作写 AuditEvent。
8. API 响应不返回 Credential 原值、Vault ref、隐藏思维链、未授权绝对路径或跨租户存在性。

## 10. API 边界验收

| 场景 | 通过条件 |
|---|---|
| Desktop 重发创建 Turn | Idempotency-Key 返回同一 Turn 和 user Item，不重复执行 |
| SSE 同毫秒多事件 | 通过 sequence 全部续读，不依赖时间戳 |
| Token 流断线 | 临时 delta 可丢，最终 Item 和 Event 可恢复 |
| Regenerate | 新 Invocation 与 agent_message；原 user Item 不复制 |
| Runtime 伪造 sequence | Ingress 拒绝；Thread sequence 只由平台分配 |
| Tool Schema 已更新 | 旧 hash 调用返回 TOOL_SCHEMA_CHANGED，Agent 重新读取 Schema |
| 用户确认 block 操作 | 无可解析 approve 请求，仍返回 POLICY_BLOCKED |
| Tool 超时 | 同 operation_id 查询 Effect；unknown_effect 不自动重放 |
| Route 灰度更新 | 仅新 Invocation 命中新 Route，旧 Binding 不变 |
| Claude Session 恢复 | 会话内容可恢复；文件状态没有 Checkpoint 时明确不声称恢复 |
| 外部 Runtime 不支持 steer | 能力探测为 false，员工端禁用并解释 |
| 管理员排障 | Actual Execution Record 可一次查询实际 Revision、能力 hash、Schema、权限、环境和成本 |

## 11. 当前代码路由的收口关系

现有 `/api/threads/*`、`/api/chat`、`/api/threads/{id}/stream` 和 `/studio/api/*` 不直接作为 公共边界承诺。实现收口时按以下关系迁移：

| 当前入口 | 入口 |
|---|---|
| `/api/chat` | `POST /api/v1/threads/{id}/turns`；不再由一个路由同时保存 Message、启动 Run 和拼 SSE |
| `/api/threads/{id}/messages` | `GET /api/v1/threads/{id}/items` |
| `/api/threads/{id}/stream`、RunTranscriptChunk | `GET /api/v1/threads/{id}/events` + transient stream |
| `/api/threads/{id}/runs/{runId}` | Turn/Invocation 详情；员工端和管理端使用不同响应视图 |
| `/api/threads/{id}/cancel` | `POST /api/v1/turns/{turnId}/interrupt` |
| `/studio/api/threads/{id}/approvals/*` | Employee UserAction resolve + Admin 风险查询；审批不只属于 Studio |
| `/studio/api/agents` | `/admin/api/v1/agents` 与 Revision 发布接口 |
| `/studio/api/skills`、custom-tools、mcp-servers | Admin 能力 API；MCP 配置降为 ToolProvider/Connection 协议类型 |
| `/studio/api/threads/{id}/context` | Admin 受控诊断视图；Runtime 按需读取走 Gateway Context API |
| `/api/threads/{id}/workspace/*` | Employee Workspace/Attachment/Artifact API；Desktop 本地操作增加设备签名 |

迁移完成后删除旧写路径，不长期维持两套 Message/Run/Event 语义。兼容路由如必须短期存在，只能调用 Application Service，不能继续写旧表。

## 最终 AgentCall 与 Continuation 协议

- AgentCall 主表只负责逻辑调用与父 Invocation 归属；revision 在 `AgentCallBinding`，context 在 `AgentSessionBinding`，task 在 `AgentCallAttempt`。
- Agent 终态先由唯一 ingress transition 写入，随后以 durable Outbox 请求父 Harness 继续；用户输入恢复同样写 Outbox，不由 HTTP route 同步抢跑。
- Agent 的失败、取消或 lost 作为结构化 Observation 返回父 Harness，由 Harness 决定后续动作，不直接篡改父 Invocation 终态。
